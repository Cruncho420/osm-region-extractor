"""PURPOSE: Refuse unsafe or drifting native proof build recipes.
RESPONSIBILITY: Digest requirements, exact preimages and source identity gate.
DEPENDENCIES: stdlib and git; does not build an image.
CONSUMERS: Connected proof tests.
"""
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("recipe", Path(__file__).with_name("prepare-valhalla-proof-toolchain.py"))
recipe = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(recipe)
UBUNTU = "ubuntu@sha256:" + "a" * 64
DOCKER = "FROM ubuntu:24.04 AS builder\nRUN bash ./scripts/install-linux-deps.sh\nFROM ubuntu:24.04 AS runner\n"
DEPS = "git clone --recurse-submodules https://github.com/kevinkreiser/prime_server $primeserver_dir\n"


class RecipeTests(unittest.TestCase):
    def test_floating_or_nonubuntu_base_refused(self):
        for value in ("ubuntu:24.04", "ubuntu@sha256:abc", "untrusted@sha256:" + "a" * 64):
            with self.assertRaisesRegex(ValueError, "Immutable Ubuntu"):
                recipe.patch_recipe(DOCKER, DEPS, value)

    def test_changed_upstream_base_or_dependency_recipe_refused(self):
        for docker, deps in ((DOCKER.replace("24.04", "22.04"), DEPS),
                             (DOCKER, DEPS.replace("--recurse-submodules", "--depth 1")),
                             (DOCKER + "RUN bash ./scripts/install-linux-deps.sh\n", DEPS)):
            with self.assertRaises(ValueError):
                recipe.patch_recipe(docker, deps, UBUNTU)

    def test_wrong_real_git_checkout_refused_without_mutation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            subprocess.run(["git", "init", "-q", str(root)], check=True)
            source = root / "retained.txt"
            source.write_text("retained")
            subprocess.run(["git", "-C", str(root), "add", "retained.txt"], check=True)
            subprocess.run(["git", "-C", str(root), "-c", "user.name=Fixture",
                            "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"], check=True)
            with self.assertRaisesRegex(ValueError, "Wrong engine"):
                recipe.prepare(root, UBUNTU, root / "receipt.json")
            self.assertFalse((root / "receipt.json").exists())
            self.assertEqual(source.read_text(), "retained")
            self.assertFalse(recipe.git(root, "status", "--porcelain").strip())


if __name__ == "__main__":
    unittest.main()
