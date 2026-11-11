const {test}=require('node:test');
const assert=require('node:assert/strict');
const C=require('./can-formats.js');
const W=require('./wire.js');
const field=(r,key)=>r.fields.find(f=>f.key===key);
const pattern=n=>Array.from({length:n},(_,i)=>i&255);

test('all nine requested combinations exist, including extended FD without BRS',()=>{
 assert.equal(C.TYPES.length,9);assert.equal(C.TYPES.filter(t=>t.remote).length,2);
 assert.equal(C.TYPES.filter(t=>t.family==='FD').length,4);
 for(const type of C.TYPES){const r=C.build({type:type.key});assert.equal(field(r,'SOF').bits,1);assert.equal(field(r,'SOF').value,0);assert.equal(field(r,'EOF').bits,7);assert.equal(r.intermissionBits,3);}
});
test('classic base bit stream agrees with the existing full decoder and CRC engine',()=>{
 for(const id of [0,1,0x200,0x7ff])for(const data of [[],[0],[255,255],pattern(8)]){
  const r=C.build({id,data}),old=W.buildCan({id,data});
  assert.equal(r.wireBits.map(b=>b.value).join(''),old.bits.map(b=>b.value).join(''));
  assert.equal(r.frameBits,44+data.length*8);assert.equal(r.wireFrameBits,r.frameBits+r.stuffing.dynamic);
  const decoded=W.decodeCan(r.wireBits);assert.equal(decoded.ok,true);assert.deepEqual(decoded.data,data);
 }
});
test('29-bit ID is split around SRR and IDE; classic extension adds 20 bits',()=>{
 const r=C.build({type:'cc-extended',id:0x1fffffff,data:pattern(8)});
 assert.deepEqual(r.fields.slice(0,9).map(f=>f.key),['SOF','ID-A','SRR','IDE','ID-B','RTR','r1','r0','DLC']);
 assert.equal(field(r,'ID-A').value,0x7ff);assert.equal(field(r,'ID-B').value,0x3ffff);
 assert.equal(field(r,'ID-A').value*2**18+field(r,'ID-B').value,r.config.id);
 assert.equal(r.frameBits,128);assert.equal(field(r,'DATA').bits,64);assert.equal(field(r,'CRC').bits,15);
});
test('remote DLC requests a length without adding data; maximum ID and empty DATA work',()=>{
 for(const [type,base] of [['cc-remote',44],['cc-extended-remote',64]])for(const requestDlc of [0,1,8]){
  const r=C.build({type,data:[],requestDlc});assert.equal(field(r,'RTR').value,1);assert.equal(field(r,'DLC').value,requestDlc);assert.equal(field(r,'DATA').bits,0);assert.equal(r.frameBits,base);
 }
 assert.throws(()=>C.build({type:'cc-remote',data:'01'}),/清空/);
 assert.throws(()=>C.build({type:'cc-remote',requestDlc:9}),/请求 DLC/);
});
test('dynamic stuffing crosses fields and never changes the identifier width',()=>{
 const a=C.build({id:1,data:[]}),b=C.build({id:0x555,data:[]});
 assert.equal(field(a,'ID').bitString,'00000000001');assert.equal(field(a,'ID').bits,11);
 assert.ok(a.wireBits.filter(v=>v.field==='ID'&&v.stuffed).length>0);
 assert.equal(b.wireBits.filter(v=>v.field==='ID'&&v.stuffed).length,0);
 // Decode stuffing using the bus levels alone, independent of stuffed metadata.
 for(const type of ['cc-extended','cc-extended-remote']){
  const r=C.build({type,id:0x1fffffff,data:type.endsWith('remote')?[]:pattern(8)});
  const wanted=r.fields.filter(f=>!['CRC delimiter','ACK','ACK delimiter','EOF','Intermission'].includes(f.key)).map(f=>f.bitString).join('');
  let decoded='',last=-1,run=0,i=0;
  while(decoded.length<wanted.length){const v=r.wireBits[i++].value;decoded+=v;run=v===last?run+1:1;last=v;if(run===5){const stuff=r.wireBits[i++].value;assert.equal(stuff,1-last);last=stuff;run=1;}}
  assert.equal(decoded,wanted);
 }
});
test('ISO FD DLC mapping, CRC width and fixed stuffing switch at the correct payload sizes',()=>{
 for(const type of ['fd-base','fd-extended','fd-brs','fd-extended-brs'])for(const [dlc,n] of C.FD_LENGTHS.entries()){
  const r=C.build({type,data:pattern(n)}),extended=r.type.extended;
  assert.equal(field(r,'DLC').value,dlc);assert.equal(field(r,'CRC').bits,n<=16?17:21);
  assert.equal(r.frameBits,(extended?72:53)+8*n+(n<=16?0:4));
  assert.equal(r.stuffing.fixed,n<=16?6:7);assert.equal(field(r,'SBC').bits,3);assert.equal(field(r,'SBC parity').bits,1);
  assert.equal(field(r,'RRS').value,0);assert.equal(field(r,'FDF').value,1);
 }
 for(const n of [9,10,11,13,17,19,25,63])assert.throws(()=>C.build({type:'fd-base',data:pattern(n)}),/长度只能/);
 assert.throws(()=>C.build({type:'fd-base',remote:true}),/没有远程帧/);
});
test('BRS affects rate regions, not ID width, payload or number of fields',()=>{
 const a=C.build({type:'fd-extended',dataRate:5000000}),b=C.build({type:'fd-extended-brs',dataRate:5000000});
 assert.equal(a.config.dataRate,500000);assert.equal(b.config.dataRate,5000000);
 assert.equal(a.frameBits,b.frameBits);assert.equal(field(a,'DATA').phase,'nominal');assert.equal(field(b,'DATA').phase,'data');
 assert.equal(field(b,'BRS').phase,'switch');assert.equal(field(b,'CRC delimiter').phase,'switch');assert.equal(field(b,'ACK').phase,'nominal');
});
test('XL: 11-bit priority, 32-bit AF, two CRCs, 1..2048-byte DLC boundaries',()=>{
 for(const n of [1,2,64,65,256,2048]){
  const r=C.build({type:'xl',id:'7FF',data:pattern(n),af:'FFFFFFFF',sdt:'FF',vcid:'FF'});
  assert.equal(field(r,'Priority ID').bits,11);assert.equal(field(r,'AF').bits,32);assert.equal(field(r,'AF').value,0xffffffff);
  assert.equal(field(r,'DLC').bits,11);assert.equal(field(r,'DLC').value,n-1);
  assert.equal(field(r,'PCRC').bits,13);assert.equal(field(r,'FCRC').bits,32);assert.equal(r.frameBits,146+8*n);
  assert.equal(field(r,'ADS').bits,4);assert.equal(field(r,'DAS').bits,4);assert.equal(field(r,'FCP').bits,4);
  assert.equal(field(r,'CRC delimiter'),undefined);assert.equal(field(r,'RTR'),undefined);assert.equal(field(r,'BRS'),undefined);
 }
 assert.throws(()=>C.build({type:'xl',data:[]}),/至少 1/);assert.throws(()=>C.build({type:'xl',data:pattern(2049)}),/最多 2048/);
 assert.throws(()=>C.build({type:'xl',id:'800'}),/优先级 ID/);assert.throws(()=>C.build({type:'xl',af:'100000000'}),/AF/);
});
test('unknown FD/XL encoded values are not exposed as calculated CRCs or full wire traces',()=>{
 for(const type of ['fd-base','fd-extended-brs','xl']){
  const r=C.build({type});assert.equal(r.wireBits,null);assert.equal(r.wireFrameBits,null);assert.equal(r.stuffing.dynamic,null);
  assert.equal(field(r,type==='xl'?'FCRC':'CRC').value,null);assert.equal(field(r,type==='xl'?'FCRC':'CRC').bitString,null);
  assert.match(r.fidelity,/未生成/);
 }
});
test('ID range validation, bit/byte units and frame boundaries',()=>{
 assert.throws(()=>C.build({id:'FFFF'}),/CAN ID/);assert.throws(()=>C.build({type:'cc-extended',id:'20000000'}),/CAN ID/);
 assert.throws(()=>C.build({id:'1garbage'}),/十六进制/);assert.throws(()=>C.build({data:pattern(9)}),/最多 8/);
 assert.equal(C.size(1),'1/8 B');assert.equal(C.size(11),'1 B + 3 bit');assert.equal(C.size(29),'3 B + 5 bit');assert.equal(C.size(32),'4 B');
 for(const t of C.TYPES){const r=C.build({type:t.key});assert.equal(r.fields.at(-1).offset,r.frameBits);assert.equal(r.steps.at(-1).stage,'done');assert.ok(r.steps.findIndex(s=>s.stage==='ack')<r.steps.findIndex(s=>s.stage==='report'));}
});
