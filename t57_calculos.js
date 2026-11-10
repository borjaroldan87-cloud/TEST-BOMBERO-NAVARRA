'use strict';
// Fuente exclusiva: CEIS Guadalajara, Riesgo eléctrico, páginas 406-425.
// Familias algebraicas derivadas de I=Q/t, I=V/R, P=VI=V²/R=I²R, P_CA=VI cos(phi),
// serie/paralelo (figs 5 y 6), relación de espiras del transformador y V=IR del cuerpo.
const families=Object.freeze([
 ['OHM_I',406,'I=V/R'],['OHM_V',406,'V=I·R'],['OHM_R',406,'R=V/I'],
 ['CARGA_Q',406,'Q=I·t'],['CARGA_I',406,'I=Q/t'],['CARGA_T',406,'t=Q/I'],
 ['POTENCIA_P',410,'P=V·I'],['POTENCIA_V',410,'V=P/I'],['POTENCIA_I',410,'I=P/V'],
 ['POTENCIA_R',410,'P=I²·R'],['POTENCIA_V2R',410,'P=V²/R'],
 ['SERIE_RT',408,'R_T=R1+R2'],['SERIE_I',408,'I=V/(R1+R2)'],['SERIE_CAIDA',408,'V1=V·R1/(R1+R2)'],
 ['PARALELO_IT',408,'I=V/R1+V/R2'],['PARALELO_REQ',408,'R_eq=(R1·R2)/(R1+R2)'],['PARALELO_RAMAL',408,'I1=V/R1'],
 ['POTENCIA_CA',410,'P=V·I·cosφ'],['FACTOR_POTENCIA',410,'cosφ=P/(V·I)'],
 ['TRAFO_V2',414,'V2=V1·N2/N1 (relación teórica ideal)'],['TRAFO_N2',414,'N2=N1·V2/V1 (relación teórica ideal)'],
 ['CONTACTO_I',423,'I=V/R'],['CONTACTO_V',423,'V=I·R'],['VIVIENDA_PREVISION',416,'Pprevista=0,60·Pinstalada']
]);
const choices=(a,r)=>a[Math.floor(r()*a.length)];
const fmt=(v,d=3)=>Number(v.toFixed(d)).toLocaleString('es-ES',{maximumFractionDigits:d});
function generate(family,variant=0,rng=Math.random){
 if(!families.some(x=>x[0]===family))throw Error('Familia ajena al PDF');
 let V=choices([12,24,48,60,120,230],rng),R1=choices([4,5,6,8,10,12,15,20],rng),R2=choices([3,5,8,10,12,15,20,25],rng);
 let I=choices([2,3,4,5,6,8,10,12],rng),T=choices([15,20,30,45,60,90,120],rng),cos=choices([0.6,0.7,0.75,0.8,0.9,0.95],rng);
 let N1=choices([400,600,800,1000,1200],rng),N2=choices([40,60,100,120,200],rng);
 let stem,value,unit,proof;const r=R1;
 switch(family){
 case 'OHM_I':stem=`Un receptor de ${r} Ω está conectado a ${V} V. ¿Qué intensidad lo atraviesa?`;value=V/r;unit='A';proof=`I=${V}/${r}`;break;
 case 'OHM_V':stem=`Una resistencia de ${r} Ω es atravesada por ${I} A. ¿Qué tensión presenta?`;value=I*r;unit='V';proof=`V=${I}×${r}`;break;
 case 'OHM_R':stem=`Por un receptor pasan ${I} A cuando se aplican ${I*r} V. ¿Cuál es su resistencia?`;value=r;unit='Ω';proof=`R=${I*r}/${I}`;break;
 case 'CARGA_Q':stem=`Durante ${T} s circulan ${I} A por un conductor. ¿Qué carga eléctrica pasa?`;value=I*T;unit='C';proof=`Q=${I}×${T}`;break;
 case 'CARGA_I':stem=`Por un conductor pasan ${I*T} C durante ${T} s. ¿Cuál es la intensidad media?`;value=I;unit='A';proof=`I=${I*T}/${T}`;break;
 case 'CARGA_T':stem=`Una corriente constante de ${I} A transporta ${I*T} C. ¿Cuánto tiempo transcurre?`;value=T;unit='s';proof=`t=${I*T}/${I}`;break;
 case 'POTENCIA_P':stem=`Un dispositivo de corriente continua trabaja a ${V} V y consume ${I} A. ¿Qué potencia absorbe?`;value=V*I;unit='W';proof=`P=${V}×${I}`;break;
 case 'POTENCIA_V':stem=`Un receptor de corriente continua consume ${V*I} W y ${I} A. ¿Qué tensión tiene?`;value=V;unit='V';proof=`V=${V*I}/${I}`;break;
 case 'POTENCIA_I':stem=`Un receptor de corriente continua consume ${V*I} W a ${V} V. ¿Qué intensidad demanda?`;value=I;unit='A';proof=`I=${V*I}/${V}`;break;
 case 'POTENCIA_R':stem=`En una resistencia de ${r} Ω circulan ${I} A. ¿Qué potencia disipa?`;value=I*I*r;unit='W';proof=`P=${I}²×${r}`;break;
 case 'POTENCIA_V2R':stem=`Una resistencia de ${r} Ω tiene ${V} V entre sus extremos. ¿Qué potencia disipa?`;value=V*V/r;unit='W';proof=`P=${V}²/${r}`;break;
 case 'SERIE_RT':stem=`Dos resistencias de ${R1} Ω y ${R2} Ω se conectan en serie. ¿Cuál es la resistencia equivalente?`;value=R1+R2;unit='Ω';proof=`R_T=${R1}+${R2}`;break;
 case 'SERIE_I':stem=`Dos resistencias de ${R1} Ω y ${R2} Ω se conectan en serie a ${V} V. ¿Cuál es la intensidad común?`;value=V/(R1+R2);unit='A';proof=`I=${V}/(${R1}+${R2})`;break;
 case 'SERIE_CAIDA':stem=`Dos resistencias de ${R1} Ω y ${R2} Ω se conectan en serie a ${V} V. ¿Cuál es la caída de tensión en la primera?`;value=V*R1/(R1+R2);unit='V';proof=`V1=${V}×${R1}/(${R1}+${R2})`;break;
 case 'PARALELO_IT':stem=`Dos resistencias de ${R1} Ω y ${R2} Ω están en paralelo a ${V} V. ¿Qué corriente total entrega la fuente?`;value=V/R1+V/R2;unit='A';proof=`I=${V}/${R1}+${V}/${R2}`;break;
 case 'PARALELO_REQ':stem=`Dos resistencias de ${R1} Ω y ${R2} Ω se conectan en paralelo. ¿Cuál es la resistencia equivalente?`;value=R1*R2/(R1+R2);unit='Ω';proof=`R_eq=${R1}×${R2}/(${R1}+${R2})`;break;
 case 'PARALELO_RAMAL':stem=`En un circuito paralelo de ${V} V, una rama tiene ${R1} Ω. ¿Qué intensidad circula por esa rama?`;value=V/R1;unit='A';proof=`I1=${V}/${R1}`;break;
 case 'POTENCIA_CA':stem=`Un receptor monofásico de CA funciona a ${V} V, ${I} A y cosφ=${fmt(cos,2)}. ¿Qué potencia activa desarrolla?`;value=V*I*cos;unit='W';proof=`P=${V}×${I}×${cos}`;break;
 case 'FACTOR_POTENCIA':stem=`Un receptor monofásico de CA recibe ${V} V y ${I} A, y desarrolla ${fmt(V*I*cos,2)} W activos. ¿Cuál es su factor de potencia?`;value=cos;unit='adimensional';proof=`cosφ=${fmt(V*I*cos,2)}/(${V}×${I})`;break;
 case 'TRAFO_V2':stem=`En un transformador ideal, el primario tiene ${N1} espiras y ${V} V, y el secundario ${N2} espiras. ¿Qué tensión secundaria teórica se obtiene?`;value=V*N2/N1;unit='V';proof=`V2=${V}×${N2}/${N1}`;break;
 case 'TRAFO_N2':stem=`En un transformador ideal, el primario tiene ${N1} espiras y ${V} V. Para obtener ${fmt(V*N2/N1,2)} V secundarios, ¿cuántas espiras necesita el secundario?`;value=N2;unit='espiras';proof=`N2=${N1}×${fmt(V*N2/N1,2)}/${V}`;break;
 case 'CONTACTO_I':{const Rc=choices([1000,2500,5000],rng),Vc=choices([24,50,75,120,230],rng);stem=`Para una resistencia corporal hipotética de ${Rc} Ω y una tensión de contacto de ${Vc} V, ¿qué corriente teórica circularía, expresada en mA?`;value=1000*Vc/Rc;unit='mA';proof=`I=${Vc}/${Rc} A = ${fmt(value)} mA`;break;}
 case 'CONTACTO_V':{const Rc=choices([1000,2500,5000],rng),mA=choices([10,20,25,30],rng);stem=`Para una corriente hipotética de ${mA} mA y una resistencia de ${Rc} Ω, ¿qué tensión corresponde por ley de Ohm?`;value=mA*Rc/1000;unit='V';proof=`V=(${mA}/1000)×${Rc}`;break;}
 case 'VIVIENDA_PREVISION':{const total=choices([12000,15000,18000,20000,24000],rng);stem=`Según la reducción del 40 % que indica el manual para sumar potencias de receptores, ¿qué previsión resulta de ${total} W instalados?`;value=0.6*total;unit='W';proof=`P=${total}×(1−0,40)`;break;}
 }
 if(!Number.isFinite(value)||value<=0)throw Error('Resultado inválido');
 const digits=(unit==='espiras'||unit==='W'||unit==='C'||unit==='s')?2:3;
 const val=Number(value.toFixed(digits));
 const seen=new Set([val]);const distract=[];
 for(const m of [1.25,0.75,1.5,0.5,2,0.9,1.1,3,0.6,1.4]){const v=Number((value*m).toFixed(digits));if(v>0&&!seen.has(v)){seen.add(v);distract.push(v);}if(distract.length===3)break;}
 if(distract.length!==3)throw Error('Distractores insuficientes');
 const arr=[val,...distract],k=((variant%4)+4)%4,opts=arr.slice(k).concat(arr.slice(0,k));
 const familyMeta=families.find(x=>x[0]===family);
 return {stem,options:opts.map(x=>`${fmt(x,digits)} ${unit}`.trim()),correctIndex:opts.indexOf(val),explanation:`${proof} = ${fmt(val,digits)} ${unit}. Fuente: CEIS Guadalajara, p. ${familyMeta[1]}.`,sourcePage:familyMeta[1]-402,manualPage:String(familyMeta[1]),questionFamily:'CALCULO_FORMULACION',difficulty:'muy alta',mathFamily:family,mathValue:val,mathUnit:unit};
}
function generateSet(n=24,rng=Math.random){return Array.from({length:n},(_,i)=>generate(families[i%families.length][0],i,rng));}
module.exports={families,generate,generateSet};
