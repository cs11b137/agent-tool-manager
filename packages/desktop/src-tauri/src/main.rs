#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backend;
use backend::{resource_root, same_origin, Backend};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::Duration,
};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_autostart::ManagerExt;

struct Desktop {
    backend: Arc<Backend>,
    launcher: Url,
    tray_available: AtomicBool,
}

fn show(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn show_error(app: &AppHandle, message: &str) {
    if let Some(window) = app.get_webview_window("main") {
        let mut url = app.state::<Desktop>().launcher.clone();
        url.query_pairs_mut().append_pair("error", message);
        let _ = window.navigate(url);
        show(app);
    }
}

fn start_service(app: &AppHandle, reveal: bool) {
    let state = app.state::<Desktop>();
    if state.backend.starting.swap(true, Ordering::SeqCst)
        || state.backend.exiting.load(Ordering::SeqCst)
    {
        return;
    }
    let backend = state.backend.clone();
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.navigate(state.launcher.clone());
    }
    if reveal {
        show(app);
    }
    let app = app.clone();
    thread::spawn(move || {
        let result = (|| {
            let resources = resource_root(app.path().resource_dir().map_err(|e| e.to_string())?);
            let log_dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
            std::fs::create_dir_all(&log_dir).map_err(|e| e.to_string())?;
            let log = log_dir.join("service.log");
            backend.start(&resources, &log).map_err(|e| {
                format!(
                    "本地服务启动失败 · Service failed to start\n{e}\n\n日志 / Log: {}",
                    log.display()
                )
            })
        })();
        if !backend.exiting.load(Ordering::SeqCst) {
            match result {
                Ok(url) => {
                    if let Some(window) = app.get_webview_window("main") {
                        if let Err(e) = window.navigate(url) {
                            show_error(&app, &format!("Cannot load workspace: {e}"));
                        }
                    }
                }
                Err(e) => show_error(&app, &e),
            }
        }
        backend.starting.store(false, Ordering::SeqCst);
    });
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| show(app)))
        .plugin(tauri_plugin_autostart::Builder::new().args(["--background"]).build())
        .setup(|app| {
            let backend = Arc::new(Backend::default());
            let nav_backend = backend.clone();
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Agent Tool Manager").inner_size(1240.0, 820.0).min_inner_size(390.0, 560.0)
                .visible(false)
                // No native commands/capabilities are exposed to the HTTP UI.
                .on_navigation(move |url| {
                    let launcher = url.scheme() == "tauri" && url.host_str() == Some("localhost")
                        || url.scheme() == "http" && url.host_str() == Some("tauri.localhost");
                    launcher || nav_backend.origin.lock().unwrap().as_ref().is_some_and(|origin| same_origin(origin, url))
                })
                .build()?;
            app.manage(Desktop { backend: backend.clone(), launcher: window.url()?, tray_available: AtomicBool::new(false) });

            let open = MenuItem::with_id(app, "open", "打开窗口 / Open window", true, Some("CmdOrCtrl+Shift+O"))?;
            let restart = MenuItem::with_id(app, "restart", "重启服务 / Restart service", true, None::<&str>)?;
            let autostart = CheckMenuItem::with_id(app, "autostart", "登录时启动 / Launch at login", true, app.autolaunch().is_enabled().unwrap_or(false), None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出 / Quit", true, Some("CmdOrCtrl+Q"))?;
            let separator = PredefinedMenuItem::separator(app)?;
            let tray_menu = Menu::with_items(app, &[&open, &restart, &autostart, &separator, &quit])?;
            let app_menu = Submenu::with_items(app, "Agent Tool Manager", true, &[&open, &restart, &autostart, &separator, &quit])?;
            let edit = Submenu::with_items(app, "编辑 / Edit", true, &[
                &PredefinedMenuItem::undo(app, None)?, &PredefinedMenuItem::redo(app, None)?,
                &PredefinedMenuItem::separator(app)?, &PredefinedMenuItem::cut(app, None)?,
                &PredefinedMenuItem::copy(app, None)?, &PredefinedMenuItem::paste(app, None)?,
                &PredefinedMenuItem::select_all(app, None)?,
            ])?;
            app.set_menu(Menu::with_items(app, &[&app_menu, &edit])?)?;
            app.on_menu_event(move |app, event| match event.id().as_ref() {
                "open" => show(app),
                "restart" => start_service(app, true),
                "quit" => app.exit(0),
                "autostart" => {
                    let manager = app.autolaunch();
                    let result = manager.is_enabled().and_then(|enabled| if enabled { manager.disable() } else { manager.enable() });
                    let _ = autostart.set_checked(manager.is_enabled().unwrap_or(false));
                    if let Err(e) = result { show_error(app, &format!("无法更改登录启动设置 / Cannot change launch at login\n{e}")); }
                }
                _ => (),
            });
            let tray_icon = if cfg!(target_os = "macos") {
                tauri::include_image!("icons/tray.png")
            } else {
                tauri::include_image!("icons/32x32.png")
            };
            let tray = TrayIconBuilder::with_id("atm")
                .icon(tray_icon)
                .icon_as_template(cfg!(target_os = "macos"))
                .tooltip("Agent Tool Manager").menu(&tray_menu).show_menu_on_left_click(true)
                .on_tray_icon_event(|tray, event| {
                    if matches!(event, TrayIconEvent::DoubleClick { button: MouseButton::Left, .. }
                        | TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. }) { show(tray.app_handle()); }
                }).build(app);
            app.state::<Desktop>().tray_available.store(tray.is_ok(), Ordering::SeqCst);
            // Environments without a tray still have a normal window and Quit action.
            let background = std::env::args().any(|a| a == "--background") && tray.is_ok();
            start_service(app.handle(), !background);

            let handle = app.handle().clone();
            thread::spawn(move || loop {
                thread::sleep(Duration::from_secs(1));
                if backend.exiting.load(Ordering::SeqCst) { break; }
                if backend.starting.load(Ordering::SeqCst) { continue; }
                let exited = {
                    let mut slot = backend.child.lock().unwrap();
                    if slot.as_mut().is_some_and(|child| matches!(child.try_wait(), Ok(Some(_)))) {
                        slot.take(); true
                    } else { false }
                };
                if exited {
                    *backend.origin.lock().unwrap() = None;
                    show_error(&handle, "本地服务已停止。请从菜单重启服务。\nThe local service stopped. Choose Restart service from the menu.");
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<Desktop>();
                if state.tray_available.load(Ordering::SeqCst) {
                    api.prevent_close();
                    let _ = window.hide();
                } else { window.app_handle().exit(0); }
            }
        })
        .build(tauri::generate_context!())
        .expect("Unable to initialize Agent Tool Manager desktop");
    app.run(|app, event| match event {
        RunEvent::Exit => {
            if let Some(state) = app.try_state::<Desktop>() {
                state.backend.exiting.store(true, Ordering::SeqCst);
                state.backend.stop();
            }
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => show(app),
        _ => (),
    });
}
