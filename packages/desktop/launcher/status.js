const error = new URL(location.href).searchParams.get('error');
if (error) {
  document.getElementById('status').textContent = error;
  document.getElementById('hint').textContent = '从应用菜单或托盘选择“重启服务”重试。\nChoose “Restart service” from the app menu or system tray to retry.';
}
