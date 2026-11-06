import { BadRequestException } from '@nestjs/common';
import { integer, object, uuid } from '../common/validation.js';
export function waitPreferences(input:unknown){
 const b=object(input,['serviceId','professionalId','fromDate','toDate','weekdays','startMinute','endMinute']);
 const date=(v:unknown)=>{if(typeof v!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v)||!Number.isFinite(Date.parse(v+'T12:00:00Z'))||new Date(v+'T12:00:00Z').toISOString().slice(0,10)!==v)throw new BadRequestException('Data inválida.');return v;};
 const fromDate=date(b.fromDate),toDate=date(b.toDate);if(fromDate>toDate||Date.parse(toDate)-Date.parse(fromDate)>90*86400000||Date.parse(toDate+'T23:59:59Z')<Date.now())throw new BadRequestException('Escolha um período futuro de até 90 dias.');
 if(!Array.isArray(b.weekdays)||b.weekdays.length<1||b.weekdays.length>7)throw new BadRequestException('Selecione dias da semana.');for(const n of b.weekdays)integer(n,'weekday',0,6);
 integer(b.startMinute,'startMinute',0,1439);integer(b.endMinute,'endMinute',1,1440);if(Number(b.endMinute)<=Number(b.startMinute))throw new BadRequestException('Faixa de horário inválida.');
 return{serviceId:uuid(b.serviceId),professionalId:b.professionalId?uuid(b.professionalId):null,fromDate,toDate,weekdays:[...new Set(b.weekdays as number[])].sort((a,b)=>a-b),startMinute:b.startMinute as number,endMinute:b.endMinute as number};
}
export function waitlistSlot(p:{fromDate:string;toDate:string;weekdays:number[];startMinute:number;endMinute:number},date:string,weekday:number,minute:number,duration:number){return date>=p.fromDate&&date<=p.toDate&&p.weekdays.includes(weekday)&&minute>=p.startMinute&&minute+duration<=p.endMinute;}
