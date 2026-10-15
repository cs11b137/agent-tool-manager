use serde::Deserialize;
use std::{
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::Url;

#[derive(Default)]
pub struct Backend {
    pub child: Mutex<Option<Child>>,
    pub origin: Mutex<Option<Url>>,
    pub starting: AtomicBool,
    pub exiting: AtomicBool,
}

#[derive(Deserialize)]
struct Ready {
    r#type: String,
    url: String,
}

pub fn ready_url(line: &str) -> Result<Url, String> {
    let ready: Ready =
        serde_json::from_str(line).map_err(|_| "Invalid service startup response")?;
    let url = Url::parse(&ready.url).map_err(|_| "Invalid service address")?;
    let pairs: Vec<_> = url.query_pairs().collect();
    if ready.r#type != "ready"
        || url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.fragment().is_some()
        || pairs.len() != 1
        || pairs[0].0 != "token"
        || pairs[0].1.len() != 43
        || !pairs[0]
            .1
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        return Err("Service did not return an authenticated loopback address".into());
    }
    Ok(url)
}

pub fn same_origin(a: &Url, b: &Url) -> bool {
    a.origin() == b.origin()
}

impl Backend {
    pub fn stop(&self) {
        *self.origin.lock().unwrap() = None;
        if let Some(mut child) = self.child.lock().unwrap().take() {
            // EOF requests graceful cancellation of tasks, SSE and file watchers.
            drop(child.stdin.take());
            let deadline = Instant::now() + Duration::from_secs(4);
            loop {
                match child.try_wait() {
                    Ok(Some(_)) => break,
                    _ if Instant::now() >= deadline => {
                        let _ = child.kill();
                        let _ = child.wait();
                        break;
                    }
                    _ => thread::sleep(Duration::from_millis(40)),
                }
            }
        }
    }

    pub fn start(&self, resources: &Path, log: &Path) -> Result<Url, String> {
        self.stop();
        let node = resources
            .join("runtime")
            .join(if cfg!(windows) { "node.exe" } else { "node" });
        let stderr =
            std::fs::File::create(log).map_err(|e| format!("Cannot open service log: {e}"))?;
        let mut command = Command::new(node);
        command
            .arg(resources.join("backend.mjs"))
            .current_dir(resources)
            .env_remove("NODE_OPTIONS")
            .env_remove("NODE_PATH")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(stderr);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        let (tx, rx) = mpsc::channel();
        {
            let mut slot = self.child.lock().unwrap();
            if self.exiting.load(Ordering::SeqCst) {
                return Err("Application is closing".into());
            }
            let mut child = command
                .spawn()
                .map_err(|e| format!("Cannot start bundled service: {e}"))?;
            let stdout = child.stdout.take().ok_or("Service stdout unavailable")?;
            *slot = Some(child);
            thread::spawn(move || {
                let mut line = String::new();
                let result = BufReader::new(stdout)
                    .take(4097)
                    .read_line(&mut line)
                    .map_err(|e| e.to_string())
                    .and_then(|_| {
                        if line.len() > 4096 {
                            Err("Startup response too long".into())
                        } else {
                            ready_url(&line)
                        }
                    });
                let _ = tx.send(result);
            });
        }
        match rx.recv_timeout(Duration::from_secs(20)) {
            Ok(Ok(url)) if !self.exiting.load(Ordering::SeqCst) => {
                *self.origin.lock().unwrap() = Some(url.clone());
                Ok(url)
            }
            result => {
                self.stop();
                Err(match result {
                    Ok(Err(e)) => e,
                    _ => "Local service did not become ready within 20 seconds".into(),
                })
            }
        }
    }
}

pub fn resource_root(app_resources: PathBuf) -> PathBuf {
    app_resources.join("resources")
}

#[cfg(test)]
mod tests {
    use super::*;
    fn message(url: &str) -> String {
        serde_json::json!({"type":"ready", "url":url}).to_string()
    }
    #[test]
    fn accepts_only_authenticated_loopback_startup() {
        let token = "a".repeat(43);
        assert!(ready_url(&message(&format!("http://127.0.0.1:12345/?token={token}"))).is_ok());
        for base in [
            "https://example.com:12345/",
            "http://localhost:12345/",
            "http://127.0.0.1/",
            "http://user@127.0.0.1:12345/",
            "http://127.0.0.1:12345/other",
        ] {
            assert!(ready_url(&message(&format!("{base}?token={token}"))).is_err());
        }
        assert!(ready_url(&message("http://127.0.0.1:12345/?token=short")).is_err());
        assert!(ready_url("{}").is_err());
    }
    #[test]
    fn navigation_requires_exact_origin() {
        let base = Url::parse("http://127.0.0.1:12345/").unwrap();
        assert!(same_origin(&base, &base.join("library").unwrap()));
        assert!(!same_origin(
            &base,
            &Url::parse("http://127.0.0.1:12346/").unwrap()
        ));
        assert!(!same_origin(
            &base,
            &Url::parse("http://localhost:12345/").unwrap()
        ));
    }
}
