import unittest,tempfile,asyncio,importlib.util,smtplib
from pathlib import Path
spec=importlib.util.spec_from_file_location('sink',Path(__file__).parents[1]/'qa/smtp-sink.py');s=importlib.util.module_from_spec(spec);spec.loader.exec_module(s)
class SinkTests(unittest.IsolatedAsyncioTestCase):
 async def asyncSetUp(self):
  self.temp=tempfile.TemporaryDirectory(prefix='kalend-smtp-unit-');self.path=Path(self.temp.name)
  self.sink=s.QaSink(self.path,['qa+unit@qa.kalend.invalid']);self.server=await asyncio.start_server(self.sink.handle,'127.0.0.1',0);self.port=self.server.sockets[0].getsockname()[1]
 async def asyncTearDown(self):self.server.close();await self.server.wait_closed();self.temp.cleanup()
 async def test_accepts_and_stores_only_private_local_mail(self):
  def send():
   with smtplib.SMTP('127.0.0.1',self.port,timeout=5) as c:c.sendmail('no-reply@kalend.dev',['qa+unit@qa.kalend.invalid'],'Subject: QA\r\n\r\nDummy QA')
  await asyncio.to_thread(send);files=list(self.path.glob('*.eml'));self.assertEqual(len(files),1);self.assertEqual(files[0].stat().st_mode&0o777,0o600)
 async def test_rejects_unlisted_recipient_without_storing(self):
  def send():
   with smtplib.SMTP('127.0.0.1',self.port,timeout=5) as c:c.sendmail('no-reply@kalend.dev',['other@example.invalid'],'Subject: QA\r\n\r\nDummy')
  with self.assertRaises(smtplib.SMTPRecipientsRefused):await asyncio.to_thread(send)
  self.assertEqual(list(self.path.glob('*.eml')),[])
 async def test_real_address_or_public_directory_rejected(self):
  with self.assertRaises(ValueError):s.QaSink(self.path,['real@example.com'])
  self.path.chmod(0o755)
  with self.assertRaises(ValueError):s.QaSink(self.path,['qa+unit@qa.kalend.invalid'])
  self.path.chmod(0o700)
if __name__=='__main__':unittest.main()
