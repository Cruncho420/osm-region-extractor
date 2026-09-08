"""PURPOSE: Exercise real gzip/tar reconstruction and rejection boundaries.
RESPONSIBILITY: Security, corruption, exact-byte union and receipt regressions.
DEPENDENCIES: Python standard library only; no native bindings or graph fixtures.
CONSUMERS: unittest; these archive tests are not native routing acceptance.
"""
import gzip
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("reconstruct", Path(__file__).with_name("reconstruct-valhalla-proof-packs.py"))
proof = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(proof)
A, B, SHARED = "2/000/001.gph", "2/000/002.gph", "0/000/003.gph"


def write_archive(path, members):
    with tarfile.open(path, "w:gz", format=tarfile.USTAR_FORMAT) as archive:
        for name, content, kind in members:
            member = tarfile.TarInfo(name)
            member.type = kind
            member.size = len(content) if kind == tarfile.REGTYPE else 0
            if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE):
                member.linkname = "../../outside"
            archive.addfile(member, io.BytesIO(content))


def regular(name, content=b"tile"):
    return (name, content, tarfile.REGTYPE)


def pax_header(record, kind=tarfile.XHDTYPE):
    member = tarfile.TarInfo("././@PaxHeader")
    member.type, member.size = kind, len(record)
    return member.tobuf(format=tarfile.USTAR_FORMAT) + record + bytes((-len(record)) % 512)


def pax_record(key, value):
    body = f" {key}={value}\n".encode("ascii")
    size = len(body) + 1
    while len(str(size)) + len(body) != size:
        size = len(str(size)) + len(body)
    return str(size).encode("ascii") + body


class ReconstructionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.first, self.second, self.output = [self.root / name for name in ("a.tar.gz", "b.tar.gz", "out")]
        self.valid = [regular("index.bin", b"archive-offsets"), regular(A), regular(SHARED)]
        write_archive(self.first, self.valid)
        write_archive(self.second, [regular("index.bin", b"different-offsets"), regular(B), regular(SHARED)])

    def run_proof(self):
        return proof.reconstruct(self.first, self.second, self.output)

    def test_exact_union_hardlinks_hashes_and_archive_specific_indexes(self):
        receipt = self.run_proof()
        self.assertEqual(receipt["union"]["count"], 3)
        self.assertEqual(receipt["union"]["bytes"], 12)
        self.assertEqual(receipt["first"]["archiveSha256"], hashlib.sha256(self.first.read_bytes()).hexdigest())
        self.assertEqual(receipt["first"]["archiveBytes"], self.first.stat().st_size)
        self.assertEqual(receipt["first"]["extractedBytes"], len(b"archive-offsets") + 8)
        for name, pack in ((A, "first"), (B, "second"), (SHARED, "first")):
            self.assertEqual((self.output / "union" / name).read_bytes(), b"tile")
            self.assertTrue(os.path.samefile(self.output / "union" / name, self.output / pack / name))
        self.assertFalse((self.output / "union/index.bin").exists())
        self.assertEqual((self.output / "second/index.bin").read_bytes(), b"different-offsets")
        self.assertEqual(json.loads((self.output / "receipt.json").read_text()), receipt)

    def test_different_duplicate_bytes_refused_even_when_same_length(self):
        write_archive(self.second, [regular("index.bin"), regular(B), regular(SHARED, b"evil")])
        with self.assertRaisesRegex(ValueError, "Conflicting"):
            self.run_proof()
        self.assertFalse((self.output / "receipt.json").exists())

    def test_existing_output_preserved(self):
        self.output.mkdir()
        (self.output / "keep").write_text("original")
        with self.assertRaisesRegex(ValueError, "already exists"):
            self.run_proof()
        self.assertEqual((self.output / "keep").read_text(), "original")

    def test_unsafe_unknown_and_noncanonical_paths(self):
        for name in ("../outside", "/outside", "2/../outside", "2\\000\\001.gph", "x.txt",
                     "2/00/001.gph", "3/000/001.gph", "./2/000/001.gph"):
            with self.subTest(name=name), tempfile.TemporaryDirectory(dir=self.root) as temp:
                write_archive(self.first, self.valid + [regular(name)])
                with self.assertRaises(ValueError):
                    proof.reconstruct(self.first, self.second, Path(temp) / "out")
        self.assertFalse((self.root / "outside").exists())

    def test_links_special_files_and_duplicate_members(self):
        for member in [("2/000/004.gph", b"", kind) for kind in
                       (tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.FIFOTYPE, tarfile.CHRTYPE)] + [regular(A), regular("index.bin")]:
            with self.subTest(member=member), tempfile.TemporaryDirectory(dir=self.root) as temp:
                write_archive(self.first, self.valid + [member])
                with self.assertRaises(ValueError):
                    proof.reconstruct(self.first, self.second, Path(temp) / "out")

    def test_required_index_tiles_and_nonempty_content(self):
        for members in ([regular(A)], [regular("index.bin")], [regular("index.bin"), regular(A, b"")],
                        [regular("index.bin", b""), regular(A)]):
            with self.subTest(members=members), tempfile.TemporaryDirectory(dir=self.root) as temp:
                write_archive(self.first, members)
                with self.assertRaises(ValueError):
                    proof.reconstruct(self.first, self.second, Path(temp) / "out")

    def test_gzip_crc_corruption_and_truncation(self):
        original = self.first.read_bytes()
        corrupt = bytearray(original)
        corrupt[-8] ^= 0xFF
        for data in (bytes(corrupt), original[:-6], original[:len(original) // 2]):
            with self.subTest(length=len(data)), tempfile.TemporaryDirectory(dir=self.root) as temp:
                self.first.write_bytes(data)
                with self.assertRaises((OSError, EOFError, tarfile.TarError, ValueError)):
                    proof.reconstruct(self.first, self.second, Path(temp) / "out")
                self.assertFalse((Path(temp) / "out/receipt.json").exists())

    def test_tar_header_corruption_and_hidden_trailer(self):
        original = gzip.decompress(self.first.read_bytes())
        corrupt = bytearray(original)
        corrupt[0] ^= 1
        for data in (bytes(corrupt), original + b"hidden"):
            with self.subTest(length=len(data)), tempfile.TemporaryDirectory(dir=self.root) as temp:
                self.first.write_bytes(gzip.compress(data))
                with self.assertRaises((tarfile.TarError, ValueError)):
                    proof.reconstruct(self.first, self.second, Path(temp) / "out")

    def test_numeric_directories_accepted(self):
        write_archive(self.first, [("2/000", b"", tarfile.DIRTYPE)] + self.valid)
        self.assertEqual(self.run_proof()["union"]["count"], 3)

    def test_extended_header_rejected_before_large_payload_read(self):
        header = tarfile.TarInfo("extended")
        header.type = tarfile.XHDTYPE
        header.size = 2 ** 40
        self.first.write_bytes(gzip.compress(header.tobuf(format=tarfile.GNU_FORMAT)))
        with self.assertRaisesRegex(ValueError, "extended headers forbidden"):
            self.run_proof()

    def test_truncated_member_and_missing_tar_end_markers(self):
        original = gzip.decompress(self.first.read_bytes())
        for data in (original[:515], original[:3072]):
            with self.subTest(length=len(data)), tempfile.TemporaryDirectory(dir=self.root) as temp:
                self.first.write_bytes(gzip.compress(data))
                with self.assertRaises(ValueError):
                    proof.reconstruct(self.first, self.second, Path(temp) / "out")

    def test_cli_emits_receipt_and_fails_when_output_exists(self):
        command = [sys.executable, "-B", str(Path(proof.__file__)), "--first", str(self.first),
                   "--second", str(self.second), "--output", str(self.output)]
        self.assertEqual(subprocess.run(command, capture_output=True).returncode, 0)
        result = subprocess.run(command, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Output already exists", result.stderr)

    def test_budgets_refuse_before_excessive_extraction(self):
        for constant, limit in (("MAX_MEMBER_BYTES", 3), ("MAX_ARCHIVE_BYTES", 14), ("MAX_MEMBERS", 1)):
            with self.subTest(constant=constant), tempfile.TemporaryDirectory(dir=self.root) as temp:
                with patch.object(proof, constant, limit), self.assertRaises(ValueError):
                    proof.reconstruct(self.first, self.second, Path(temp) / "out")

    def test_symlink_archive_and_output_parent_refused(self):
        alias = self.root / "alias"
        alias.symlink_to(self.first)
        with self.assertRaises(ValueError):
            proof.reconstruct(alias, self.second, self.output)
        alias.unlink()
        alias.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(ValueError):
            proof.reconstruct(self.first, self.second, alias / "out")

    def test_native_python_tar_add_fractional_mtime_roundtrip(self):
        # Pinned valhalla_build_extract uses default tarfile.open("w") + add();
        # that emits a local mtime PAX header for filesystem fractional mtimes.
        tile = self.root / "tile"
        tile.write_bytes(b"tile")
        os.utime(tile, ns=(1700000000123456789, 1700000000123456789))
        with tarfile.open(self.first, "w:gz") as archive:
            index = tarfile.TarInfo("index.bin")
            index.size = 16
            archive.addfile(index, io.BytesIO(bytes(16)))
            archive.add(tile, arcname=A)
        with tarfile.open(self.first) as archive:
            self.assertEqual(set(archive.getmember(A).pax_headers), {"mtime"})
        receipt = self.run_proof()
        self.assertEqual((self.output / "first" / A).read_bytes(), b"tile")
        self.assertEqual(receipt["first"]["tiles"][0]["sha256"], hashlib.sha256(b"tile").hexdigest())

    def test_pax_cannot_override_paths_sizes_links_or_sparse_semantics(self):
        original = gzip.decompress(self.first.read_bytes())
        for key, value in (("path", "../outside"), ("linkpath", A), ("size", "999"),
                           ("GNU.sparse.map", "0,4"), ("uid", "0"), ("unknown", "ignored")):
            with self.subTest(key=key), tempfile.TemporaryDirectory(dir=self.root) as temp:
                extension = pax_header(pax_record(key, value))
                self.first.write_bytes(gzip.compress(original[:1024] + extension + original[1024:]))
                with self.assertRaises(ValueError):
                    proof.reconstruct(self.first, self.second, Path(temp) / "out")

    def test_pax_rejects_malformed_duplicate_global_and_orphan_metadata(self):
        original = gzip.decompress(self.first.read_bytes())
        record = pax_record("mtime", "1700000000.1234567")
        extensions = [pax_header(b"99 mtime=1\n"), pax_header(pax_record("mtime", "nan")),
                      pax_header(record + record), pax_header(record, tarfile.XGLTYPE),
                      pax_header(record) + pax_header(record)]
        for extension in extensions:
            with self.subTest(extension=extension[:160]), tempfile.TemporaryDirectory(dir=self.root) as temp:
                self.first.write_bytes(gzip.compress(original[:1024] + extension + original[1024:]))
                with self.assertRaises(ValueError):
                    proof.reconstruct(self.first, self.second, Path(temp) / "out")
        self.first.write_bytes(gzip.compress(original[:1024] + pax_header(record) + bytes(1024)))
        with self.assertRaises(ValueError):
            self.run_proof()

    def test_allowed_pax_never_bypasses_member_validation(self):
        record = pax_header(pax_record("mtime", "1700000000.1234567"))
        for member in (regular("../outside"), regular(A), (A, b"", tarfile.LNKTYPE),
                       ("2/000", b"", tarfile.DIRTYPE)):
            with self.subTest(member=member), tempfile.TemporaryDirectory(dir=self.root) as temp:
                write_archive(self.first, self.valid + [member])
                raw = gzip.decompress(self.first.read_bytes())
                self.first.write_bytes(gzip.compress(raw[:3072] + record + raw[3072:]))
                with self.assertRaises(ValueError):
                    proof.reconstruct(self.first, self.second, Path(temp) / "out")


if __name__ == "__main__":
    unittest.main()
