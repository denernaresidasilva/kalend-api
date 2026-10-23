import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('promote',ROOT/'scripts/ops/promote_dev.py');P=importlib.util.module_from_spec(spec);spec.loader.exec_module(P)
SHA='a'*40


class PromotionTests(unittest.TestCase):
    def fixture(self,path):
        (path/'app').mkdir();(path/'app/old.txt').write_text('old')
        c=path/('candidate.'+SHA);c.mkdir();(c/'new.txt').write_text('new')
        (c/'RELEASE.json').write_text(json.dumps({'sha':SHA,'database':'kalend_dev'}))

    def test_promotes_and_keeps_previous_without_starting_anything(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d);self.fixture(p)
            r=P.switch(p,SHA,os.getuid(),os.getuid())
            self.assertTrue((p/'app/new.txt').exists());self.assertTrue((p/('previous-before-'+SHA)/'old.txt').exists());self.assertFalse(r['services_started'])

    def test_existing_backup_is_never_overwritten(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d);self.fixture(p);(p/('previous-before-'+SHA)).mkdir()
            with self.assertRaises(ValueError):P.switch(p,SHA,os.getuid(),os.getuid())
            self.assertTrue((p/'app/old.txt').exists())

    def test_target_symlink_or_wrong_database_fails_before_rename(self):
        for mode in ['symlink','database']:
            with tempfile.TemporaryDirectory() as d:
                p=Path(d);self.fixture(p)
                if mode=='symlink':(p/'app').rename(p/'actual');(p/'app').symlink_to(p/'actual',target_is_directory=True)
                else:(p/('candidate.'+SHA)/'RELEASE.json').write_text(json.dumps({'sha':SHA,'database':'kalend'}))
                with self.assertRaises(ValueError):P.switch(p,SHA,os.getuid(),os.getuid())

    def test_failed_second_rename_restores_path_but_never_starts_old_api(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d);self.fixture(p);original=os.rename
            def rename(src,dst,**kwargs):
                if src=='candidate.'+SHA:raise OSError('synthetic promotion failure')
                return original(src,dst,**kwargs)
            with patch('os.rename',side_effect=rename):
                with self.assertRaises(OSError):P.switch(p,SHA,os.getuid(),os.getuid())
            self.assertTrue((p/'app/old.txt').exists());self.assertTrue((p/('candidate.'+SHA)).exists())

    def test_fifo_artifact_marker_is_rejected_without_blocking(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d);self.fixture(p);marker=p/('candidate.'+SHA)/'RELEASE.json'
            marker.unlink();os.mkfifo(marker)
            with self.assertRaises(ValueError):P.switch(p,SHA,os.getuid(),os.getuid())
            self.assertTrue((p/'app/old.txt').exists())

    def test_invalid_ref_or_wrong_executor_rejected(self):
        for sha,uid in [('main',os.getuid()),(SHA,0),(SHA,os.getuid()+1)]:
            with self.assertRaises(ValueError):P.switch('/unreachable',sha,uid,os.getuid())


if __name__=='__main__':unittest.main()
