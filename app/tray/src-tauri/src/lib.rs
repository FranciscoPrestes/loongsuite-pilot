use std::path::{Path, PathBuf};

use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, PhysicalPosition, WebviewWindow,
};

const DATA_DIR_ENV: &str = "LOONGSUITE_PILOT_DATA_DIR";
const PANEL: &str = "panel";
const SHORTCUT_ENV: &str = "NTC_TES_SHORTCUT";
// Not Cmd/Ctrl+Shift+T (browsers reopen tab) nor Ctrl+Alt+T (Ubuntu terminal).
const DEFAULT_SHORTCUT: &str = "CommandOrControl+Alt+Shift+T";

const TRAY_ICON_ON_DARK: &[u8] = include_bytes!("../icons/tray/tray-dark.png");
const TRAY_ICON_ON_LIGHT: &[u8] = include_bytes!("../icons/tray/tray-light.png");

/// White mark on dark bars, near-black mark on light bars; the eye stays blue.
fn tray_icon_bytes(theme: tauri::Theme) -> &'static [u8] {
    match theme {
        tauri::Theme::Light => TRAY_ICON_ON_LIGHT,
        _ => TRAY_ICON_ON_DARK,
    }
}

fn tray_icon(theme: tauri::Theme) -> Option<tauri::image::Image<'static>> {
    tauri::image::Image::from_bytes(tray_icon_bytes(theme)).ok()
}

fn parse_shortcut(raw: Option<String>) -> Result<Shortcut, String> {
    let spec = raw.filter(|v| !v.is_empty()).unwrap_or_else(|| DEFAULT_SHORTCUT.to_string());
    spec.parse::<Shortcut>().map_err(|e| format!("invalid shortcut '{spec}': {e}"))
}

/// Pilot data dir: `$LOONGSUITE_PILOT_DATA_DIR` or `~/.loongsuite-pilot`.
fn resolve_data_dir(env_override: Option<String>, home: Option<PathBuf>) -> Option<PathBuf> {
    match env_override.filter(|v| !v.is_empty()) {
        Some(dir) => Some(PathBuf::from(dir)),
        None => home.map(|h| h.join(".loongsuite-pilot")),
    }
}

/// Only these two files are readable from the webview; anything else is rejected.
fn file_for(name: &str) -> Option<&'static str> {
    match name {
        "runtime" => Some("runtime.json"),
        "metrics" => Some("metrics-summary.json"),
        _ => None,
    }
}

fn read_logs_file(data_dir: &Path, file: &str) -> Result<Option<String>, String> {
    let path = data_dir.join("logs").join(file);
    match std::fs::read_to_string(&path) {
        Ok(raw) => Ok(Some(raw)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

#[tauri::command]
fn read_pilot_file(name: String) -> Result<Option<String>, String> {
    let file = file_for(&name).ok_or_else(|| format!("unknown file: {name}"))?;
    let dir = resolve_data_dir(std::env::var(DATA_DIR_ENV).ok(), dirs::home_dir())
        .ok_or_else(|| "home directory not found".to_string())?;
    read_logs_file(&dir, file)
}

/// Place the panel next to the tray icon: below it on a top bar (macOS, most Linux),
/// above it on a bottom taskbar (Windows).
fn place_panel(win: &WebviewWindow, click: PhysicalPosition<f64>) {
    let Ok(Some(monitor)) = win.current_monitor() else { return };
    let Ok(size) = win.outer_size() else { return };
    let screen = monitor.size();
    let origin = monitor.position();
    let w = size.width as f64;
    let h = size.height as f64;
    let x = (click.x - w / 2.0)
        .max(origin.x as f64)
        .min(origin.x as f64 + screen.width as f64 - w);
    let bottom_bar = click.y > origin.y as f64 + screen.height as f64 / 2.0;
    let y = if bottom_bar { click.y - h - 12.0 } else { click.y + 12.0 };
    let _ = win.set_position(PhysicalPosition::new(x, y.max(origin.y as f64)));
}

fn show_panel(app: &tauri::AppHandle, click: Option<PhysicalPosition<f64>>) {
    let Some(win) = app.get_webview_window(PANEL) else { return };
    match click {
        Some(pos) => place_panel(&win, pos),
        None => {
            let _ = win.center();
        }
    }
    let _ = win.show();
    let _ = win.set_focus();
    let _ = app.emit("panel-shown", ());
}

fn toggle_panel(app: &tauri::AppHandle, click: Option<PhysicalPosition<f64>>) {
    let visible = app
        .get_webview_window(PANEL)
        .map(|w| w.is_visible().unwrap_or(false))
        .unwrap_or(false);
    if visible {
        if let Some(win) = app.get_webview_window(PANEL) {
            let _ = win.hide();
        }
    } else {
        show_panel(app, click);
    }
}

pub fn run() {
    let app = tauri::Builder::default()
        // A second launch (Start menu, launcher, Dock) opens the panel of the running app.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_panel(app, None)))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        toggle_panel(app, None);
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![read_pilot_file])
        .setup(|app| {
            // Works even when the menu bar/tray has no room (notch, GNOME without tray).
            match parse_shortcut(std::env::var(SHORTCUT_ENV).ok()) {
                Ok(shortcut) => {
                    if let Err(e) = app.global_shortcut().register(shortcut) {
                        eprintln!("could not register panel shortcut: {e}");
                    }
                }
                Err(e) => eprintln!("{e}"),
            }

            let open = MenuItem::with_id(app, "open", "Abrir painel", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Sair", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            let theme = app
                .get_webview_window(PANEL)
                .and_then(|w| w.theme().ok())
                .unwrap_or(tauri::Theme::Dark);
            let icon = tray_icon(theme).ok_or("missing tray icon")?;

            TrayIconBuilder::with_id("tes")
                .icon(icon)
                .tooltip("NT TES")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => toggle_panel(app, None),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        position,
                        ..
                    } = event
                    {
                        toggle_panel(tray.app_handle(), Some(position));
                    }
                })
                .build(app)?;

            // Dev/QA aid: open the panel at launch, centered, without needing the tray icon.
            if std::env::var("NTC_TES_SHOW").is_ok() {
                if let Some(win) = app.get_webview_window(PANEL) {
                    let _ = win.center();
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                tauri::WindowEvent::Focused(false) if window.label() == PANEL => {
                    let _ = window.hide();
                }
                tauri::WindowEvent::ThemeChanged(theme) => {
                    if let (Some(tray), Some(icon)) =
                        (window.app_handle().tray_by_id("tes"), tray_icon(*theme))
                    {
                        let _ = tray.set_icon(Some(icon));
                    }
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building NT TES tray");

    app.run(|_app, _event| {
        // Dock icon click on macOS reopens the panel.
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = _event {
            show_panel(_app, None);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_override_wins_over_home() {
        let dir = resolve_data_dir(Some("/tmp/pilot".into()), Some("/home/u".into()));
        assert_eq!(dir, Some(PathBuf::from("/tmp/pilot")));
    }

    #[test]
    fn empty_env_falls_back_to_home() {
        let dir = resolve_data_dir(Some(String::new()), Some(PathBuf::from("/home/u")));
        assert_eq!(dir, Some(PathBuf::from("/home/u/.loongsuite-pilot")));
    }

    #[test]
    fn no_env_and_no_home_is_none() {
        assert_eq!(resolve_data_dir(None, None), None);
    }

    #[test]
    fn only_known_names_map_to_files() {
        assert_eq!(file_for("runtime"), Some("runtime.json"));
        assert_eq!(file_for("metrics"), Some("metrics-summary.json"));
        assert_eq!(file_for("../../etc/passwd"), None);
    }

    #[test]
    fn tray_icon_follows_theme_and_decodes() {
        assert_eq!(tray_icon_bytes(tauri::Theme::Light), TRAY_ICON_ON_LIGHT);
        assert_eq!(tray_icon_bytes(tauri::Theme::Dark), TRAY_ICON_ON_DARK);
        assert_ne!(TRAY_ICON_ON_LIGHT, TRAY_ICON_ON_DARK);
        assert!(tray_icon(tauri::Theme::Light).is_some());
        assert!(tray_icon(tauri::Theme::Dark).is_some());
    }

    #[test]
    fn default_shortcut_parses() {
        assert!(parse_shortcut(None).is_ok());
        assert!(parse_shortcut(Some(String::new())).is_ok());
    }

    #[test]
    fn custom_shortcut_is_honoured_and_garbage_rejected() {
        assert!(parse_shortcut(Some("Ctrl+Alt+F9".into())).is_ok());
        assert!(parse_shortcut(Some("not a shortcut".into())).is_err());
    }

    #[test]
    fn missing_file_is_none_not_error() {
        let dir = std::env::temp_dir().join("ntc-tes-tray-missing");
        assert_eq!(read_logs_file(&dir, "runtime.json"), Ok(None));
    }
}
