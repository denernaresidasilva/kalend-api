#!/usr/bin/env python3
"""Ephemeral loopback-only SMTP receiver. No relay, DNS, outbound connection or provider."""
import argparse
import asyncio
import json
import os
from pathlib import Path
import re
from uuid import uuid4

class QaSink:
    def __init__(self, directory, recipients):
        self.directory=Path(directory)
        if self.directory.is_symlink() or self.directory.stat().st_uid!=os.getuid() or self.directory.stat().st_mode & 0o077:
            raise ValueError('PRIVATE_DIRECTORY_REQUIRED')
        self.recipients=set(recipients)
        if not self.recipients or any(not re.fullmatch(r'qa\+[^@\s]+@qa\.kalend\.invalid',x) for x in self.recipients):
            raise ValueError('RESERVED_QA_RECIPIENTS_ONLY')
        self.accepted=len(list(self.directory.glob("*.eml")))

    async def handle(self, reader, writer):
        recipients=[];sender=False
        async def reply(s):writer.write((s+'\r\n').encode());await writer.drain()
        try:
            await reply('220 localhost Kalend QA sink')
            while True:
                raw=await asyncio.wait_for(reader.readline(),timeout=30)
                if not raw:break
                line=raw.decode('ascii','replace').strip();command=line.split(' ',1)[0].upper()
                if command in ('EHLO','HELO'):await reply('250-localhost\r\n250 SIZE 1048576')
                elif command=='MAIL':sender=True;recipients=[];await reply('250 OK')
                elif command=='RCPT':
                    m=re.fullmatch(r'RCPT TO:\s*<([^>]+)>',line,re.I)
                    address=m.group(1).lower() if m else ''
                    if not sender:await reply('503 MAIL required')
                    elif address not in self.recipients:await reply('550 QA recipient rejected')
                    else:recipients.append(address);await reply('250 OK')
                elif command=='DATA':
                    if not recipients:await reply('503 RCPT required');continue
                    if self.accepted>=100:await reply('452 QA sink capacity reached');continue
                    await reply('354 End with dot')
                    chunks=[];size=0
                    while True:
                        chunk=await asyncio.wait_for(reader.readline(),timeout=30)
                        if not chunk:return
                        if chunk in (b'.\r\n',b'.\n'):break
                        if chunk.startswith(b'..'):chunk=chunk[1:]
                        size+=len(chunk)
                        if size>1048576:await reply('552 Message too large');return
                        chunks.append(chunk)
                    fd=os.open(self.directory/(str(uuid4())+'.eml'),os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
                    with os.fdopen(fd,'wb') as f:f.write(b''.join(chunks));f.flush();os.fsync(f.fileno())
                    self.accepted+=1;recipients=[];sender=False;await reply('250 Stored in QA sink')
                elif command=='RSET':recipients=[];sender=False;await reply('250 OK')
                elif command=='NOOP':await reply('250 OK')
                elif command=='QUIT':await reply('221 Bye');break
                else:await reply('502 Unsupported')
        except (TimeoutError,ConnectionError,ValueError):pass
        finally:
            writer.close()
            try:await writer.wait_closed()
            except ConnectionError:pass

async def main():
    if os.getuid()==0:raise SystemExit('NONROOT_REQUIRED')
    p=argparse.ArgumentParser();p.add_argument('--directory',required=True);p.add_argument('--recipients',required=True);p.add_argument('--lifetime',type=int,choices=[0,7200],default=7200);a=p.parse_args()
    sink=QaSink(a.directory,json.loads(Path(a.recipients).read_text()))
    server=await asyncio.start_server(sink.handle,'127.0.0.1',1025,limit=65536)
    print('QA_SMTP_READY_LOOPBACK_1025',flush=True)
    async with server:
        if a.lifetime:await asyncio.sleep(a.lifetime)
        else:await server.serve_forever()
if __name__=='__main__':asyncio.run(main())
