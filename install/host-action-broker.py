#!/usr/bin/env python3
import argparse
import ast
import json
import os
import shutil
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


HOME = Path("/home/nomad")
DESKTOP_ROOT = HOME / "Desktop"
APPLICATIONS_ROOT = HOME / ".local" / "share" / "applications"
SESSION_ENV = {
    "HOME": str(HOME),
    "XDG_CONFIG_HOME": str(HOME / ".config"),
    "XDG_RUNTIME_DIR": "/run/user/1000",
    "DBUS_SESSION_BUS_ADDRESS": "unix:path=/run/user/1000/bus",
    "DISPLAY": ":0",
}
BROKER_TOKEN = os.environ.get("NOMAD_HOST_BROKER_TOKEN", "").strip()


def run_command(args: list[str]) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env.update(SESSION_ENV)
    return subprocess.run(args, capture_output=True, text=True, env=env, check=False)


def current_favorites() -> list[str]:
    result = run_command(["gsettings", "get", "org.gnome.shell", "favorite-apps"])
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "Failed to read GNOME favorites")

    raw = result.stdout.strip()
    try:
        value = ast.literal_eval(raw)
    except Exception as exc:
        raise RuntimeError(f"Could not parse GNOME favorites: {raw}") from exc

    if not isinstance(value, list):
        raise RuntimeError("GNOME favorites response was not a list")

    return [item for item in value if isinstance(item, str)]


def set_favorites(favorites: list[str]) -> None:
    serialized = "[" + ", ".join(repr(item) for item in favorites) + "]"
    result = run_command(["gsettings", "set", "org.gnome.shell", "favorite-apps", serialized])
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "Failed to write GNOME favorites")


def normalize_desktop_id(desktop_id: str) -> str:
    desktop_id = desktop_id.strip()
    if not desktop_id.endswith(".desktop"):
        raise ValueError("desktop_id must end with .desktop")
    if "/" in desktop_id or desktop_id.startswith("."):
        raise ValueError("desktop_id must be a plain .desktop filename")
    return desktop_id


def desktop_paths(desktop_id: str) -> tuple[Path, Path]:
    safe_id = normalize_desktop_id(desktop_id)
    return DESKTOP_ROOT / safe_id, APPLICATIONS_ROOT / safe_id


def ensure_launcher_exists(desktop_id: str) -> Path:
    desktop_src, app_dst = desktop_paths(desktop_id)

    if desktop_src.is_file():
        APPLICATIONS_ROOT.mkdir(parents=True, exist_ok=True)
        shutil.copy2(desktop_src, app_dst)
        return app_dst

    if app_dst.is_file():
        return app_dst

    raise FileNotFoundError(f"Could not find launcher {desktop_id} on the Desktop or in applications")


def display_name_for(desktop_id: str) -> str:
    mapping = {
        "home-assistant.desktop": "Home Assistant",
        "nomad.desktop": "N.O.M.A.D.",
        "nomad-start.desktop": "N.O.M.A.D. Start",
    }
    return mapping.get(desktop_id, desktop_id)


def broker_health() -> dict:
    bus_path = Path("/run/user/1000/bus")
    status = {
        "status": "ok",
        "session_bus_available": bus_path.exists(),
        "applications_root": str(APPLICATIONS_ROOT),
        "desktop_root": str(DESKTOP_ROOT),
    }

    try:
        status["favorites"] = current_favorites()
    except Exception as exc:
        status["status"] = "degraded"
        status["favorites_error"] = str(exc)

    return status


def supported_actions() -> list[dict]:
    return [
        {
            "action": "favorites.list",
            "description": "List the current GNOME favorite launchers for the active Ubuntu session.",
        },
        {
            "action": "favorites.pin",
            "description": "Pin a .desktop launcher to GNOME favorites and verify it.",
            "params": ["desktop_id"],
        },
        {
            "action": "favorites.unpin",
            "description": "Remove a .desktop launcher from GNOME favorites and verify it.",
            "params": ["desktop_id"],
        },
        {
            "action": "desktop.shortcut.exists",
            "description": "Check whether a launcher exists on the Desktop or in the applications directory.",
            "params": ["desktop_id"],
        },
        {
            "action": "desktop.shortcut.remove",
            "description": "Remove a launcher from the Desktop and applications directory.",
            "params": ["desktop_id"],
        },
        {
            "action": "applications.launcher.sync_from_desktop",
            "description": "Copy a Desktop launcher into ~/.local/share/applications and verify it.",
            "params": ["desktop_id"],
        },
    ]


def execute_action(action: str, params: dict) -> dict:
    if action == "favorites.list":
        favorites = current_favorites()
        return {
            "ok": True,
            "message": "I checked the current Ubuntu favorites list.",
            "favorites": favorites,
        }

    if action == "favorites.pin":
        desktop_id = normalize_desktop_id(str(params.get("desktop_id") or ""))
        ensure_launcher_exists(desktop_id)
        favorites = current_favorites()
        already_present = desktop_id in favorites
        if not already_present:
            favorites.append(desktop_id)
            set_favorites(favorites)

        verified = current_favorites()
        if desktop_id not in verified:
            raise RuntimeError(f"GNOME favorites update did not verify for {desktop_id}")

        display_name = display_name_for(desktop_id)
        return {
            "ok": True,
            "message": (
                f"{display_name} is already pinned in the Ubuntu sidebar."
                if already_present
                else f"I pinned {display_name} to the Ubuntu sidebar and verified it."
            ),
            "favorites": verified,
        }

    if action == "favorites.unpin":
        desktop_id = normalize_desktop_id(str(params.get("desktop_id") or ""))
        favorites = current_favorites()
        was_present = desktop_id in favorites
        updated = [item for item in favorites if item != desktop_id]
        if was_present:
            set_favorites(updated)

        verified = current_favorites()
        if desktop_id in verified:
            raise RuntimeError(f"GNOME favorites removal did not verify for {desktop_id}")

        display_name = display_name_for(desktop_id)
        return {
            "ok": True,
            "message": (
                f"{display_name} was not pinned in the Ubuntu sidebar."
                if not was_present
                else f"I removed {display_name} from the Ubuntu sidebar and verified it."
            ),
            "favorites": verified,
        }

    if action == "desktop.shortcut.exists":
        desktop_id = normalize_desktop_id(str(params.get("desktop_id") or ""))
        desktop_src, app_dst = desktop_paths(desktop_id)
        exists = {
            "desktop": desktop_src.is_file(),
            "applications": app_dst.is_file(),
        }
        return {
            "ok": True,
            "message": f"I checked whether {desktop_id} exists in the approved launcher locations.",
            "exists": exists,
        }

    if action == "desktop.shortcut.remove":
        desktop_id = normalize_desktop_id(str(params.get("desktop_id") or ""))
        desktop_src, app_dst = desktop_paths(desktop_id)
        removed = []
        for candidate, label in ((desktop_src, "desktop"), (app_dst, "applications")):
            if candidate.exists():
                candidate.unlink()
                removed.append(label)

        return {
            "ok": True,
            "message": (
                f"I removed {desktop_id} from: {', '.join(removed)}."
                if removed
                else f"{desktop_id} was not present in the approved launcher locations."
            ),
            "removed": removed,
        }

    if action == "applications.launcher.sync_from_desktop":
        desktop_id = normalize_desktop_id(str(params.get("desktop_id") or ""))
        desktop_src, app_dst = desktop_paths(desktop_id)
        if not desktop_src.is_file():
            raise FileNotFoundError(f"Missing Desktop launcher: {desktop_src}")
        APPLICATIONS_ROOT.mkdir(parents=True, exist_ok=True)
        shutil.copy2(desktop_src, app_dst)
        if not app_dst.is_file():
            raise RuntimeError(f"Launcher copy did not verify for {desktop_id}")
        return {
            "ok": True,
            "message": f"I copied {display_name_for(desktop_id)} into the applications directory and verified it.",
            "path": str(app_dst),
        }

    raise ValueError(f"Unsupported action: {action}")


class Handler(BaseHTTPRequestHandler):
    server_version = "NomadHostActionBroker/1.0"

    def log_message(self, _format: str, *_args) -> None:
        return

    def _json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length > 0 else b"{}"
        return json.loads(raw.decode("utf-8") or "{}")

    def _authorized(self) -> bool:
        if not BROKER_TOKEN:
            return True
        return self.headers.get("X-Nomad-Broker-Token", "") == BROKER_TOKEN

    def do_GET(self) -> None:
        if self.path == "/health":
            self._json(200, broker_health())
            return

        if not self._authorized():
            self._json(403, {"error": "Forbidden"})
            return

        if self.path == "/v1/actions":
            self._json(200, {"actions": supported_actions()})
            return

        if self.path == "/v1/session/favorites":
            try:
                self._json(200, {"favorites": current_favorites()})
            except Exception as exc:
                self._json(503, {"error": str(exc)})
            return

        self._json(404, {"error": "Not found"})

    def do_POST(self) -> None:
        if not self._authorized():
            self._json(403, {"error": "Forbidden"})
            return

        if self.path == "/v1/actions/execute":
            try:
                payload = self._read_json()
                action = str(payload.get("action") or "").strip()
                params = payload.get("params") or {}
                if not action:
                    raise ValueError("action is required")
                if not isinstance(params, dict):
                    raise ValueError("params must be an object")
                self._json(200, execute_action(action, params))
            except FileNotFoundError as exc:
                self._json(404, {"error": str(exc)})
            except ValueError as exc:
                self._json(400, {"error": str(exc)})
            except Exception as exc:
                self._json(503, {"error": str(exc)})
            return

        # Compatibility endpoints while the admin side catches up.
        if self.path == "/v1/session/favorites/pin":
            try:
                payload = self._read_json()
                desktop_id = str(payload.get("desktop_id") or "").strip()
                self._json(200, execute_action("favorites.pin", {"desktop_id": desktop_id}))
            except FileNotFoundError as exc:
                self._json(404, {"error": str(exc)})
            except ValueError as exc:
                self._json(400, {"error": str(exc)})
            except Exception as exc:
                self._json(503, {"error": str(exc)})
            return

        self._json(404, {"error": "Not found"})


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
