import type { Prisma } from '@prisma/client';
export function waitlistLink(variables:Prisma.JsonValue):string|null{
 if(!variables||typeof variables!=='object'||Array.isArray(variables)||typeof variables.url_agenda!=='string')return null;
 try{const u=new URL(variables.url_agenda),id=u.searchParams.get('opportunity');if(u.protocol!=='https:'||u.hash||!/^\/agendar\/[a-z0-9-]{1,100}$/.test(u.pathname)||!id||id!==variables.__opportunityId||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)||[...u.searchParams.keys()].some(k=>k!=='opportunity'))return null;return u.pathname+u.search;}catch{return null;}
}
