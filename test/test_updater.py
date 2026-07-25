import hashlib
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

from updater import ApplyError, REQUIRED_FILES, load_and_extract, safe_relative_path


class UpdaterTests(unittest.TestCase):
    def test_rejects_parent_directory_path(self):
        with self.assertRaises(ApplyError):
            safe_relative_path("../outside.txt")

    def test_extracts_files_listed_in_verified_manifest(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            package = root / "update.zip"
            staging = root / "staging"
            files = {
                name: f"content for {name}".encode("utf-8")
                for name in REQUIRED_FILES
            }
            manifest = {
                "version": "1.0.3",
                "files": [
                    {
                        "path": name,
                        "sha256": hashlib.sha256(content).hexdigest(),
                    }
                    for name, content in sorted(files.items())
                ],
            }
            with zipfile.ZipFile(package, "w") as archive:
                for name, content in files.items():
                    archive.writestr(name, content)
                archive.writestr(
                    "update-manifest.json",
                    json.dumps(manifest),
                )

            extracted = load_and_extract(package, staging, "1.0.3")
            self.assertEqual(set(extracted), {Path(name) for name in REQUIRED_FILES})
            self.assertEqual(
                (staging / "native-ui.py").read_bytes(),
                files["native-ui.py"],
            )


if __name__ == "__main__":
    unittest.main()
