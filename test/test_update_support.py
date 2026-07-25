import unittest

from update_support import (
    UpdateError,
    is_newer_version,
    parse_sha256_file,
    parse_version,
    select_release_update,
)


class UpdateSupportTests(unittest.TestCase):
    def test_version_comparison(self):
        self.assertEqual(parse_version("v1.2.3"), (1, 2, 3, 0))
        self.assertTrue(is_newer_version("1.0.10", "1.0.9"))
        self.assertFalse(is_newer_version("1.0.2", "1.0.2"))

    def test_selects_expected_release_assets(self):
        checksum = "a" * 64
        release = {
            "tag_name": "v1.0.3",
            "html_url": "https://github.com/kristong769-maker/efficient_sell/releases/tag/v1.0.3",
            "draft": False,
            "prerelease": False,
            "body": "自动更新",
            "assets": [
                {
                    "name": "other.zip",
                    "browser_download_url": "https://github.com/kristong769-maker/efficient_sell/releases/download/v1.0.3/other.zip",
                },
                {
                    "name": "efficent_sell-v1.0.3.zip",
                    "browser_download_url": "https://github.com/kristong769-maker/efficient_sell/releases/download/v1.0.3/efficent_sell-v1.0.3.zip",
                    "digest": f"sha256:{checksum}",
                },
                {
                    "name": "efficent_sell-v1.0.3.zip.sha256",
                    "browser_download_url": "https://github.com/kristong769-maker/efficient_sell/releases/download/v1.0.3/efficent_sell-v1.0.3.zip.sha256",
                },
            ],
        }
        update = select_release_update(release, "1.0.2")
        self.assertTrue(update["is_newer"])
        self.assertEqual(update["zip_name"], "efficent_sell-v1.0.3.zip")
        self.assertEqual(update["sha256"], checksum)
        self.assertTrue(update["checksum_url"].endswith(".zip.sha256"))

    def test_rejects_asset_from_another_repository(self):
        release = {
            "tag_name": "v1.0.3",
            "draft": False,
            "prerelease": False,
            "assets": [
                {
                    "name": "efficent_sell-v1.0.3.zip",
                    "browser_download_url": "https://example.com/update.zip",
                }
            ],
        }
        with self.assertRaises(UpdateError):
            select_release_update(release, "1.0.2")

    def test_reads_checksum_file(self):
        checksum = "b" * 64
        text = f"{checksum}  efficent_sell-v1.0.3.zip\n"
        self.assertEqual(
            parse_sha256_file(text, "efficent_sell-v1.0.3.zip"),
            checksum,
        )


if __name__ == "__main__":
    unittest.main()
