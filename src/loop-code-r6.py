from __future__ import annotations

import json
import logging
import os
import re
import tempfile
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator, TypedDict

try:
    import fcntl
except ImportError:  # pragma: no cover - Windows/non-POSIX
    fcntl = None  # type: ignore[assignment]

logger = logging.getLogger(__name__)

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

class UserRecord(TypedDict):
    name: str
    email: str

class UserView(TypedDict):
    id: int
    name: str
    email: str

class UserManager:
    """POSIX file-locking based user store with thread/process-safe access."""

    def __init__(
        self,
        db_path: str | Path | None = None,
        *,
        strict_mode: bool = True,
    ) -> None:
        if fcntl is None or os.name == "nt":
            raise OSError("UserManager requires POSIX file locking (fcntl); Windows is not supported")

        if db_path is None:
            db_path = Path.home() / ".local" / "share" / "myapp" / "users.json"

        self.db_path = Path(db_path).expanduser()
        self._lock_path = self.db_path.with_name(f"{self.db_path.name}.lock")
        self.strict_mode = strict_mode
        self._thread_lock = threading.RLock()
        self.users: dict[int, UserRecord] = {}
        self._email_index: dict[str, int] = {}
        self._next_id: int = 1
        self._last_loaded_signature: str = ""
        self.load()

    def add_user(self, name: str, email: str) -> int:
        clean_name = name.strip()
        clean_email = email.strip()

        if not clean_name:
            raise ValueError("name must not be empty")
        if not clean_email:
            raise ValueError("email must not be empty")
        if not _EMAIL_RE.fullmatch(clean_email):
            raise ValueError("invalid email format")

        email_key = self._normalize_email(clean_email)

        with self._locked(exclusive=True):
            self._load_locked()

            if email_key in self._email_index:
                raise ValueError("email already exists")

            user_id = self._next_user_id()
            self.users[user_id] = {"name": clean_name, "email": clean_email}
            self._email_index[email_key] = user_id
            self._save_locked()

            return user_id

    def get_user(self, user_id: int) -> UserRecord:
        with self._locked(exclusive=False):
            self._load_locked()

            try:
                user = self.users[user_id]
            except KeyError as e:
                raise KeyError(f"user not found: {user_id}") from e

            return {"name": user["name"], "email": user["email"]}

    def list_users(self) -> list[UserView]:
        with self._locked(exclusive=False):
            self._load_locked()
            return [
                {"id": user_id, "name": record["name"], "email": record["email"]}
                for user_id, record in sorted(self.users.items(), key=lambda item: item[0])
            ]

    def update_user(
        self,
        user_id: int,
        *,
        name: str | None = None,
        email: str | None = None,
    ) -> UserRecord:
        if name is None and email is None:
            raise ValueError("at least one of name or email must be provided")

        with self._locked(exclusive=True):
            self._load_locked()

            if user_id not in self.users:
                raise KeyError(f"user not found: {user_id}")

            current = self.users[user_id]
            new_name = current["name"] if name is None else name.strip()
            new_email = current["email"] if email is None else email.strip()

            if not new_name:
                raise ValueError("name must not be empty")
            if not new_email:
                raise ValueError("email must not be empty")
            if not _EMAIL_RE.fullmatch(new_email):
                raise ValueError("invalid email format")

            old_email_key = self._normalize_email(current["email"])
            new_email_key = self._normalize_email(new_email)
            existing_user_id = self._email_index.get(new_email_key)

            if existing_user_id is not None and existing_user_id != user_id:
                raise ValueError("email already exists")

            self.users[user_id] = {"name": new_name, "email": new_email}

            if new_email_key != old_email_key:
                self._email_index.pop(old_email_key, None)
                self._email_index[new_email_key] = user_id

            self._save_locked()
            return {"name": new_name, "email": new_email}

    def delete_user(self, user_id: int) -> None:
        with self._locked(exclusive=True):
            self._load_locked()

            if user_id not in self.users:
                raise KeyError(f"user not found: {user_id}")

            email_key = self._normalize_email(self.users[user_id]["email"])
            del self.users[user_id]
            self._email_index.pop(email_key, None)
            self._save_locked()

    def save(self) -> None:
        with self._locked(exclusive=True):
            current_users = self._clone_users(self.users)
            current_next_id = self._next_id
            expected_base_signature = self._last_loaded_signature
            current_signature = self._state_signature(current_users, current_next_id)

            self._load_locked()
            latest_disk_signature = self._last_loaded_signature

            # Optimistic concurrency check:
            # if the on-disk state changed since this instance last loaded it,
            # and our in-memory state is not already equal to that latest state,
            # refuse to overwrite and require an explicit reload/merge.
            if (
                expected_base_signature
                and expected_base_signature != latest_disk_signature
                and current_signature != latest_disk_signature
            ):
                raise RuntimeError("database changed on disk; reload before saving")

            self.users = current_users
            self._next_id = current_next_id
            self._save_locked()

    def load(self) -> None:
        with self._locked(exclusive=False):
            self._load_locked()

    @contextmanager
    def _locked(self, *, exclusive: bool) -> Iterator[None]:
        with self._thread_lock:
            self.db_path.parent.mkdir(parents=True, exist_ok=True)
            with self._lock_path.open("a", encoding="utf-8") as lock_file:
                lock_type = fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH
                fcntl.flock(lock_file.fileno(), lock_type)
                try:
                    yield
                finally:
                    fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)

    def _save_locked(self) -> None:
        users, next_id, email_index = self._normalize_users(
            self.users,
            self._next_id,
            source="memory",
        )
        self.users = users
        self._next_id = next_id
        self._email_index = email_index

        payload = {
            "_next_id": self._next_id,
            "users": {str(user_id): record for user_id, record in self.users.items()},
        }

        tmp_path: Path | None = None
        fd = -1

        try:
            self.db_path.parent.mkdir(parents=True, exist_ok=True)

            fd, tmp_name = tempfile.mkstemp(
                prefix=f"{self.db_path.name}.",
                suffix=".tmp",
                dir=str(self.db_path.parent),
            )
            tmp_path = Path(tmp_name)

            try:
                os.fchmod(fd, 0o600)
            except (AttributeError, OSError):
                pass

            try:
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    fd = -1
                    json.dump(payload, f, ensure_ascii=False, indent=2)
                    f.flush()
                    os.fsync(f.fileno())
            finally:
                if fd != -1:
                    os.close(fd)
                    fd = -1

            tmp_path.replace(self.db_path)
            self.db_path.chmod(0o600)
            self._last_loaded_signature = self._state_signature(self.users, self._next_id)
        except OSError as e:
            if fd != -1:
                try:
                    os.close(fd)
                except OSError:
                    pass

            if tmp_path is not None:
                try:
                    tmp_path.unlink(missing_ok=True)
                except OSError:
                    logger.warning("failed to remove temporary file: %s", tmp_path)

            raise OSError(f"failed to save users to {self.db_path}") from e

    def _load_locked(self) -> None:
        if not self.db_path.exists():
            self.users = {}
            self._email_index = {}
            self._next_id = 1
            self._last_loaded_signature = self._state_signature(self.users, self._next_id)
            return

        try:
            with self.db_path.open("r", encoding="utf-8") as f:
                data: Any = json.load(f)
        except json.JSONDecodeError as e:
            raise ValueError(f"invalid JSON in {self.db_path}") from e
        except OSError as e:
            raise OSError(f"failed to load users from {self.db_path}") from e

        if not isinstance(data, dict):
            raise ValueError("user database must be a JSON object")

        if "users" in data or "_next_id" in data:
            raw_users = data.get("users")
            raw_next_id = data.get("_next_id", 1)

            if not isinstance(raw_users, dict):
                raise ValueError("database field 'users' must be a JSON object")
        else:
            raw_users = data
            raw_next_id = 1

        users, next_id, email_index = self._normalize_users(
            raw_users,
            raw_next_id,
            source="database",
        )
        self.users = users
        self._next_id = next_id
        self._email_index = email_index
        self._last_loaded_signature = self._state_signature(self.users, self._next_id)

    def _normalize_users(
        self,
        raw_users: Any,
        raw_next_id: Any,
        *,
        source: str,
    ) -> tuple[dict[int, UserRecord], int, dict[str, int]]:
        if not isinstance(raw_users, dict):
            raise ValueError(f"{source} users must be a mapping")

        loaded_users: dict[int, UserRecord] = {}
        email_index: dict[str, int] = {}

        for raw_user_id, raw_user in raw_users.items():
            try:
                user_id = int(raw_user_id)
                if user_id < 1:
                    raise ValueError("user id must be >= 1")
            except (TypeError, ValueError) as e:
                if self.strict_mode:
                    raise ValueError(f"invalid user id in {source}: {raw_user_id!r}") from e
                logger.warning("skipping invalid user id in %s: %r", source, raw_user_id)
                continue

            if not isinstance(raw_user, dict):
                if self.strict_mode:
                    raise ValueError(f"user entry must be an object in {source} for user id {user_id}")
                logger.warning("skipping non-object user entry in %s for id %s", source, user_id)
                continue

            name = raw_user.get("name")
            email = raw_user.get("email")

            if not isinstance(name, str) or not isinstance(email, str):
                if self.strict_mode:
                    raise ValueError(f"user entry must contain string name/email in {source} for user id {user_id}")
                logger.warning("skipping invalid user entry in %s for id %s", source, user_id)
                continue

            name = name.strip()
            email = email.strip()

            if not name or not email:
                if self.strict_mode:
                    raise ValueError(f"user entry must not contain empty name/email in {source} for user id {user_id}")
                logger.warning("skipping empty name/email in %s for id %s", source, user_id)
                continue

            if not _EMAIL_RE.fullmatch(email):
                if self.strict_mode:
                    raise ValueError(f"invalid email format in {source} for user id {user_id}")
                logger.warning("skipping invalid email in %s for id %s", source, user_id)
                continue

            email_key = self._normalize_email(email)
            if email_key in email_index:
                if self.strict_mode:
                    raise ValueError(f"duplicate email in {source} for user id {user_id}")
                logger.warning("skipping duplicate email in %s for id %s", source, user_id)
                continue

            loaded_users[user_id] = {"name": name, "email": email}
            email_index[email_key] = user_id

        if not isinstance(raw_next_id, int) or raw_next_id < 1:
            if self.strict_mode:
                raise ValueError(f"{source} _next_id must be an integer >= 1")
            logger.warning("resetting invalid _next_id in %s", source)
            raw_next_id = 1

        computed_next_id = max(loaded_users.keys(), default=0) + 1
        next_id = max(raw_next_id, computed_next_id)

        return loaded_users, next_id, email_index

    def _next_user_id(self) -> int:
        user_id = self._next_id
        self._next_id += 1
        return user_id

    @staticmethod
    def _normalize_email(email: str) -> str:
        return email.casefold().strip()

    @staticmethod
    def _clone_users(users: dict[int, UserRecord]) -> dict[int, UserRecord]:
        return {
            user_id: {"name": record["name"], "email": record["email"]}
            for user_id, record in users.items()
        }

    @staticmethod
    def _state_signature(users: dict[int, UserRecord], next_id: int) -> str:
        payload = {
            "_next_id": next_id,
            "users": {
                str(user_id): {"name": record["name"], "email": record["email"]}
                for user_id, record in sorted(users.items(), key=lambda item: item[0])
            },
        }
        return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

    try:
        manager = UserManager(strict_mode=False)
        user_id = manager.add_user("test", "test@example.com")
        manager.update_user(user_id, name="updated test")
        print(manager.get_user(user_id))
        print(manager.list_users())
    except (ValueError, KeyError, OSError, RuntimeError) as e:
        print(f"error: {e}")
