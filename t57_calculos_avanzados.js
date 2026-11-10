 'use strict';
// T57 CEIS 406,408,410: ejercicios preconstruidos; Gemini no redacta ni resuelve.
// 6 topologías × 5 magnitudes = 30 familias. Solo cambia datos de un conjunto validado.
const sets=[
 {a:8,b:12,c:6,V:120,t:240}, {a:10,b:15,c:30,V:180,t:180},
 {a:6,b:18,c:9,V:96,t:300}, {a:12,b:24,c:8,V:160,t:150},
 {a:5,b:10,c:20,V:105,t:360}, {a:9,b:27,c:18,V:144,t:200},
 {a:4,b:16,c:16,V:120,t:270}, {a:15,b:30,c:10,V:210,t:120},
 {a:7,b:21,c:14,V:168,t:240}, {a:18,b:36,c:12,V:240,t:300}
];
const fmt=n=>Number(n.toFixed(3)).toLocaleString('es-ES',{maximumFractionDigits:3});
const defs=[
 ['MIXTO_RAMA_P', 'La fuente alimenta R1 en serie con el paralelo R2-R3. ¿Qué potencia disipa exclusivamente R2?', 'W', s=>s.vp*s.vp/s.b],
 ['MIXTO_RAMA_I', 'La fuente alimenta R1 en serie con el paralelo R2-R3. ¿Qué intensidad circula exclusivamente por R3?', 'A',s=>s.vp/s.c],
 ['MIXTO_CAIDA', 'La fuente alimenta R1 en serie con el paralelo R2-R3. ¿Qué caída de tensión presenta R1?', 'V',s=>s.I*s.a],
 ['MIXTO_P_TOTAL', 'La fuente alimenta R1 en serie con el paralelo R2-R3. ¿Qué potencia total suministra?', 'W',s=>s.V*s.I],
 ['MIXTO_PORCENTAJE','La fuente alimenta R1 en serie con el paralelo R2-R3. ¿Qué porcentaje de la potencia total se disipa en R1?', '%',s=>100*s.a/s.req],
 ['MIXTO_ENERGIA_R3','La fuente alimenta R1 en serie con el paralelo R2-R3. ¿Cuánta energía disipa R3 durante el intervalo indicado?', 'kJ',s=>s.vp*s.vp/s.c*s.t/1000],
 ['MIXTO_CARGA_R2','La fuente alimenta R1 en serie con el paralelo R2-R3. ¿Qué carga circula por R2 durante el intervalo indicado?', 'C',s=>s.vp/s.b*s.t],
 ['MIXTO_RAMA_RELACION','La fuente alimenta R1 en serie con el paralelo R2-R3. ¿Qué porcentaje de la corriente total circula por R2?', '%',s=>100*(s.vp/s.b)/s.I],
 ['MIXTO_P_R1','La fuente alimenta R1 en serie con el paralelo R2-R3. ¿Qué potencia disipa únicamente R1?', 'W',s=>s.I*s.I*s.a],
 ['MIXTO_R_EQ','La fuente alimenta R1 en serie con el paralelo R2-R3. ¿Qué resistencia equivalente presenta el conjunto?', 'Ω',s=>s.req],
 ['INVERSO_V_DESDE_P1','En R1 se disipa la potencia indicada. R1 está en serie con el paralelo R2-R3. ¿Qué tensión debe entregar la fuente?', 'V',s=>Math.sqrt(s.p1/s.a)*s.req],
 ['INVERSO_V_DESDE_I3','Por R3 circula la intensidad indicada. R1 está en serie con el paralelo R2-R3. ¿Qué tensión total debe entregar la fuente?', 'V',s=>s.i3*s.c*(1+s.a/s.rp)],
 ['INVERSO_P_TOTAL','Por R2 circula la intensidad indicada. R1 está en serie con el paralelo R2-R3. ¿Qué potencia total suministra la fuente?', 'W',s=>(s.i2*s.b/s.rp)**2*s.req],
 ['INVERSO_I_TOTAL','La caída de tensión en R1 es la indicada. R1 está en serie con el paralelo R2-R3. ¿Qué intensidad circula por R3?', 'A',s=>(s.v1/s.a)*s.rp/s.c],
 ['INVERSO_ENERGIA','En R1 se disipa la potencia indicada. R1 está en serie con el paralelo R2-R3. ¿Qué energía total entrega la fuente en el intervalo indicado?', 'kJ',s=>(s.p1/s.a)*s.req*s.t/1000],
 ['SERIE_P2','R1, R2 y R3 se conectan en serie a la fuente. ¿Qué potencia disipa R2?', 'W',s=>(s.V/(s.a+s.b+s.c))**2*s.b],
 ['SERIE_E3','R1, R2 y R3 se conectan en serie a la fuente. ¿Qué energía disipa R3 en el intervalo indicado?', 'kJ',s=>(s.V/(s.a+s.b+s.c))**2*s.c*s.t/1000],
 ['SERIE_V2','R1, R2 y R3 se conectan en serie a la fuente. ¿Qué tensión cae en R2?', 'V',s=>s.V*s.b/(s.a+s.b+s.c)],
 ['SERIE_CARGA','R1, R2 y R3 se conectan en serie a la fuente. ¿Qué carga circula durante el intervalo indicado?', 'C',s=>s.V/(s.a+s.b+s.c)*s.t],
 ['SERIE_PORC','R1, R2 y R3 se conectan en serie a la fuente. ¿Qué porcentaje de la potencia total corresponde a R3?', '%',s=>100*s.c/(s.a+s.b+s.c)],
 ['PARALELO_P2','R1, R2 y R3 se conectan en paralelo a la fuente. ¿Qué potencia disipa exclusivamente R2?', 'W',s=>s.V*s.V/s.b],
 ['PARALELO_I_TOTAL','R1, R2 y R3 se conectan en paralelo a la fuente. ¿Qué intensidad total suministra?', 'A',s=>s.V*(1/s.a+1/s.b+1/s.c)],
 ['PARALELO_ENERGIA','R1, R2 y R3 se conectan en paralelo a la fuente. ¿Qué energía total consumen durante el intervalo indicado?', 'kJ',s=>s.V*s.V*(1/s.a+1/s.b+1/s.c)*s.t/1000],
 ['PARALELO_CARGA3','R1, R2 y R3 se conectan en paralelo a la fuente. ¿Qué carga circula exclusivamente por R3 durante el intervalo indicado?', 'C',s=>s.V/s.c*s.t],
 ['PARALELO_PORC','R1, R2 y R3 se conectan en paralelo a la fuente. ¿Qué porcentaje de la potencia total consume R1?', '%',s=>100*(1/s.a)/(1/s.a+1/s.b+1/s.c)],
 ['INVERSO_SERIE_V','En un circuito serie R1-R2-R3, R2 disipa la potencia indicada. ¿Qué tensión total aplica la fuente?', 'V',s=>Math.sqrt(s.ps2/s.b)*(s.a+s.b+s.c)],
 ['INVERSO_SERIE_I','En un circuito serie R1-R2-R3, R3 disipa la potencia indicada. ¿Qué intensidad común circula?', 'A',s=>Math.sqrt(s.ps3/s.c)],
 ['INVERSO_PAR_V','En un circuito paralelo R1-R2-R3, R2 disipa la potencia indicada. ¿Qué tensión aplica la fuente?', 'V',s=>Math.sqrt(s.pp2*s.b)],
 ['INVERSO_PAR_I','En un circuito paralelo R1-R2-R3, R1 disipa la potencia indicada. ¿Qué corriente total entrega la fuente?', 'A',s=>Math.sqrt(s.pp1*s.a)*(1/s.a+1/s.b+1/s.c)],
 ['INVERSO_PAR_E','En un circuito paralelo R1-R2-R3, R3 disipa la potencia indicada. ¿Qué energía total consume el circuito en el intervalo indicado?', 'kJ',s=>s.pp3*s.c*(1/s.a+1/s.b+1/s.c)*s.t/1000]
];
const families=Object.freeze(defs.map(d=>d[0]));
function generate(family,variant=0){
 const d=defs.find(x=>x[0]===family);if(!d)throw Error('Familia no reconocida');
 const v=sets[((variant%sets.length)+sets.length)%sets.length];
 const rp=v.b*v.c/(v.b+v.c),req=v.a+rp,I=v.V/req,vp=I*rp;
 const s={...v,rp,req,I,vp,p1:I*I*v.a,i2:vp/v.b,i3:vp/v.c,v1:I*v.a,
 ps2:(v.V/(v.a+v.b+v.c))**2*v.b,ps3:(v.V/(v.a+v.b+v.c))**2*v.c,
 pp1:v.V*v.V/v.a,pp2:v.V*v.V/v.b,pp3:v.V*v.V/v.c};
 let stem=`${d[1].replaceAll('R1','R₁').replaceAll('R2','R₂').replaceAll('R3','R₃')} Datos: R₁=${v.a} Ω, R₂=${v.b} Ω, R₃=${v.c} Ω`;
 const inv=family.startsWith('INVERSO');
 if(inv){
 const extra=family==='INVERSO_V_DESDE_P1'||family==='INVERSO_ENERGIA'?`P(R₁)=${fmt(s.p1)} W`:
 family==='INVERSO_V_DESDE_I3'?`I(R₃)=${fmt(s.i3)} A`:
 family==='INVERSO_P_TOTAL'?`I(R₂)=${fmt(s.i2)} A`:
 family==='INVERSO_I_TOTAL'?`V(R₁)=${fmt(s.v1)} V`:
 family==='INVERSO_SERIE_V'?`P(R₂)=${fmt(s.ps2)} W`:
 family==='INVERSO_SERIE_I'?`P(R₃)=${fmt(s.ps3)} W`:
 family==='INVERSO_PAR_V'?`P(R₂)=${fmt(s.pp2)} W`:
 family==='INVERSO_PAR_I'?`P(R₁)=${fmt(s.pp1)} W`:`P(R₃)=${fmt(s.pp3)} W`;
 stem+=`, ${extra}`;
 }else stem+=`, tensión de fuente=${v.V} V`;
 if(/ENERGIA|CARGA/.test(family))stem+=`, tiempo=${v.t} s`;
 stem+='.';
 const value=d[3](s);const correct=Number(value.toFixed(3));
 const wrong=[value*0.75,value*1.25,value*1.5,value*0.5,value*2,value*0.9,value*1.1].map(x=>Number(x.toFixed(3))).filter(x=>x>0&&x!==correct);
 const distinct=[...new Set(wrong)].slice(0,3);if(distinct.length!==3)throw Error('Distractores insuficientes');
 const all=[correct,...distinct];const shift=((variant%4)+4)%4;const rotated=all.slice(shift).concat(all.slice(0,shift));
 return {stem,options:rotated.map(n=>`${fmt(n)} ${d[2]}`),correctIndex:rotated.indexOf(correct),explanation:`Topología: ${family}; Rpar=${fmt(rp)} Ω, Rmixta=${fmt(req)} Ω, I_mixta=${fmt(I)} A, Vpar=${fmt(vp)} V. Resultado: ${fmt(correct)} ${d[2]}.`,mathValue:correct,mathUnit:d[2],mathFamily:family,manualPages:[406,408,410],difficulty:'muy alta',questionFamily:'T57_CALCULO'};
}
export default {families,generate};
