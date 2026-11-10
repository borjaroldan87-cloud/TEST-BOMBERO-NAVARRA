'use strict';
// Solo combinaciones algebraicas de I=V/R, P=VI, I=Q/t, serie y paralelo,
// factor de potencia monofásico y relación ideal de espiras (CEIS 406,408,410,414).
const metadata = Object.freeze([
 ['SERIE_POTENCIA',408,410],['PARALELO_POTENCIA',408,410],
 ['MIXTO_EQUIVALENTE',408,406],['MIXTO_INTENSIDAD',408,406],
 ['SERIE_CAIDA_POTENCIA',408,410],['OHM_CARGA_TIEMPO',406,406],
 ['TRAFO_CARGA_RESISTIVA',414,406],['CA_FACTOR_Y_POTENCIA',410,410]
]);
const pick=(xs,r)=>xs[Math.floor(r()*xs.length)];
const format=x=>Number(x.toFixed(3)).toLocaleString('es-ES',{maximumFractionDigits:3});
function generate(family,variant=0,rng=Math.random){
 if(!metadata.some(x=>x[0]===family))throw Error('Familia desconocida');
 const V=pick([24,48,60,120,230],rng),R1=pick([4,6,8,10,12,20],rng),R2=pick([4,5,8,10,15,20],rng),R3=pick([5,10,15,20],rng);
 const T=pick([15,30,60,120],rng),factor=pick([0.6,0.7,0.8,0.9],rng);
 let stem,value,unit,steps;
 switch(family){
 case 'SERIE_POTENCIA': {let r=R1+R2;value=V*V/r;unit='W';stem=`Dos resistencias de ${R1} Ω y ${R2} Ω están en serie bajo ${V} V de corriente continua. ¿Qué potencia total se disipa?`;steps=`R=${R1}+${R2}=${r} Ω; P=V²/R=${V}²/${r}`;break;}
 case 'PARALELO_POTENCIA':{value=V*V/R1+V*V/R2;unit='W';stem=`Dos resistencias de ${R1} Ω y ${R2} Ω están en paralelo a ${V} V de corriente continua. ¿Qué potencia total consumen?`;steps=`P1=V²/R1=${V}²/${R1}; P2=V²/R2=${V}²/${R2}; P=P1+P2`;break;}
 case 'MIXTO_EQUIVALENTE':{let rp=R2*R3/(R2+R3);value=R1+rp;unit='Ω';stem=`Una resistencia de ${R1} Ω está en serie con dos resistencias de ${R2} Ω y ${R3} Ω conectadas entre sí en paralelo. ¿Cuál es la resistencia equivalente?`;steps=`Rpar=${R2}×${R3}/(${R2}+${R3}); Req=${R1}+Rpar`;break;}
 case 'MIXTO_INTENSIDAD':{let rp=R2*R3/(R2+R3);value=V/(R1+rp);unit='A';stem=`Una resistencia de ${R1} Ω está en serie con una asociación paralela de ${R2} Ω y ${R3} Ω. Si la fuente continua es de ${V} V, ¿qué corriente entrega?`;steps=`Rpar=${R2}×${R3}/(${R2}+${R3}); I=${V}/(${R1}+Rpar)`;break;}
 case 'SERIE_CAIDA_POTENCIA':{let I=V/(R1+R2);value=I*I*R1;unit='W';stem=`Dos resistencias de ${R1} Ω y ${R2} Ω están en serie a ${V} V continuos. ¿Qué potencia disipa únicamente la primera?`;steps=`I=${V}/(${R1}+${R2}); P1=I²×${R1}`;break;}
 case 'OHM_CARGA_TIEMPO':{let I=V/R1;value=I*T;unit='C';stem=`Un conductor de ${R1} Ω sometido a ${V} V continuos mantiene la corriente durante ${T} s. ¿Qué carga atraviesa el conductor?`;steps=`I=${V}/${R1}; Q=I×${T}`;break;}
 case 'TRAFO_CARGA_RESISTIVA':{let n1=pick([400,600,800],rng),n2=pick([100,200],rng),v2=V*n2/n1;value=v2/R1;unit='A';stem=`Un transformador ideal recibe ${V} V en un devanado de ${n1} espiras; el secundario tiene ${n2} espiras y alimenta una resistencia de ${R1} Ω. ¿Qué intensidad secundaria teórica resulta?`;steps=`V2=${V}×${n2}/${n1}; I2=V2/${R1}`;break;}
 case 'CA_FACTOR_Y_POTENCIA':{let I=pick([3,5,8,10],rng);value=V*I*factor;unit='W';stem=`Un receptor monofásico de CA absorbe ${I} A a ${V} V, con factor de potencia ${format(factor)}. ¿Qué potencia activa desarrolla?`;steps=`P=${V}×${I}×${factor}`;break;}
 }
 if(!(value>0&&Number.isFinite(value)))throw Error('Valor inválido');
 const correct=Number(value.toFixed(3));const values=[correct];
 for(const m of [0.5,0.75,1.25,1.5,2,3]){const d=Number((value*m).toFixed(3));if(d>0&&!values.includes(d))values.push(d);if(values.length===4)break;}
 if(values.length!==4)throw Error('Opciones insuficientes');
 const k=((variant%4)+4)%4;const options=values.slice(k).concat(values.slice(0,k));
 const m=metadata.find(x=>x[0]===family);
 return {stem,options:options.map(v=>`${format(v)} ${unit}`),correctIndex:options.indexOf(correct),explanation:`${steps}; resultado ${format(correct)} ${unit}.`,mathValue:correct,mathUnit:unit,mathFamily:family,manualPages:[...new Set(m.slice(1))],difficulty:'ALTA_COMBINADA_REQUIERE_REVISION_PEDAGOGICA',source:'CEIS Guadalajara, riesgo eléctrico'};
}
export default {metadata,generate};
