'use strict';
// Tema 56: calculos documentados CEIS, pp. 357-360. Sin servicios externos.
const PI=3.14;
const families=Object.freeze([
 {id:'ALTURA',page:358,formula:'H=h·D/d',description:'Semejanza de triángulos'},
 {id:'DISTANCIA',page:358,formula:'D=H·d/h',description:'Despeje de distancia'},
 {id:'RADIO',page:358,formula:'r=P/(2π)',description:'Radio por perímetro'},
 {id:'VOLUMEN',page:358,formula:'V=πr²H',description:'Volumen cilíndrico'},
 {id:'PESO',page:357,formula:'m=V·ρ',description:'Masa por volumen y densidad'},
 {id:'ALTURA_VOLUMEN',page:358,formula:'H=h·D/d; V=πr²H',description:'Altura y volumen encadenados'},
 {id:'PERIMETRO_PESO',page:358,formula:'r=P/(2π); V=πr²H; m=V·ρ',description:'Perímetro, volumen y masa'},
 {id:'ALTURA_PESO',page:358,formula:'H=h·D/d; V=πr²H; m=V·ρ',description:'Altura, volumen y masa'},
 {id:'PESO_INVERSO',page:357,formula:'V=m/ρ',description:'Volumen a partir de masa y densidad'},
 {id:'DENSIDAD_INVERSA',page:357,formula:'ρ=m/V',description:'Densidad a partir de masa y volumen'}
]);
const pick=(a,rng)=>a[Math.floor(rng()*a.length)];
const fmt=(v,d=2)=>Number(v.toFixed(d)).toLocaleString('es-ES',{minimumFractionDigits:d,maximumFractionDigits:d});
function generate(family,variant=0,rng=Math.random){
 const h=pick([24,32,36,42,48,56,64],rng),D=pick([12,15,18,21,24,30],rng),d=pick([48,56,60,70,75,80],rng);
 const height=h*D*100/(d*100); // cm de regla * metros / cm de distancia ocular
 const circumference=pick([125.6,157,188.4,219.8,251.2,282.6],rng); // cm, π=3,14
 const radius=circumference/(2*PI)/100; // m
 const height2=pick([9,12,15,18,21],rng),density=pick([0.6,0.8,1.0,1.1],rng); // kg/dm3
 const vol=PI*radius*radius*height2;
 const r2=pick([0.18,0.22,0.26,0.30,0.34],rng),vol2=PI*r2*r2*height;
 let stem,value,unit,proof,pg;
 switch(family){
 case 'ALTURA':stem=`Desde ${D} m de distancia, un árbol ocupa ${h} cm de una regla vertical situada a ${d} cm del ojo. ¿Qué altura aproximada tiene?`;value=height;unit='m';proof=`H = (${h} cm × ${D} m) / ${d} cm = ${fmt(value)} m.`;pg=358;break;
 case 'DISTANCIA':{const H=height;stem=`Un árbol mide ${fmt(H)} m y ocupa ${h} cm de una regla situada a ${d} cm del ojo. ¿A qué distancia horizontal del árbol se efectuó la medición?`;value=D;unit='m';proof=`D = H × d / h = ${fmt(H)} × ${d} / ${h} = ${fmt(value)} m.`;pg=358;break;}
 case 'RADIO':stem=`El perímetro de un tronco es ${fmt(circumference,1)} cm. Utilizando π=3,14, ¿cuál es su radio en metros?`;value=radius;unit='m';proof=`r = P/(2π) = ${fmt(circumference,1)}/6,28 = ${fmt(value*100)} cm = ${fmt(value)} m.`;pg=358;break;
 case 'VOLUMEN':stem=`Se aproxima un árbol mediante un cilindro de radio ${fmt(radius*100,0)} cm y altura ${height2} m. ¿Qué volumen se obtiene con π=3,14?`;value=vol;unit='m³';proof=`V = 3,14 × (${fmt(radius)} m)² × ${height2} m = ${fmt(value)} m³.`;pg=358;break;
 case 'PESO':{const V=pick([2.5,3.2,3.6,4.5,5.4,6.2],rng);stem=`Para un volumen aproximado de ${fmt(V,1)} m³ y una densidad aparente de ${fmt(density,1)} kg/dm³, ¿qué masa se estima?`;value=V*density*1000;unit='kg';proof=`ρ = ${fmt(density,1)} kg/dm³ = ${fmt(density*1000,0)} kg/m³; m = Vρ = ${fmt(V,1)} × ${fmt(density*1000,0)} = ${fmt(value,2)} kg.`;pg=360;break;}
 case 'ALTURA_VOLUMEN':stem=`A ${D} m de un árbol se observan ${h} cm de regla a ${d} cm del ojo. Su radio es ${fmt(r2*100,0)} cm. Aproximándolo por un cilindro, ¿qué volumen tiene? Usa π=3,14.`;value=vol2;unit='m³';proof=`H = ${h}×${D}/${d} = ${fmt(height)} m; V=3,14×${fmt(r2)}²×${fmt(height)}=${fmt(value)} m³.`;pg=358;break;
 case 'PERIMETRO_PESO':stem=`Un árbol tiene perímetro de tronco ${fmt(circumference,1)} cm, altura ${height2} m y densidad aparente ${fmt(density,1)} kg/dm³. Con el modelo cilíndrico y π=3,14, ¿qué masa aproximada resulta?`;value=vol*density*1000;unit='kg';proof=`r=${fmt(circumference,1)}/(2×3,14)=${fmt(radius*100)} cm; V=3,14×${fmt(radius)}²×${height2}=${fmt(vol)} m³; m=V×${fmt(density*1000,0)}=${fmt(value)} kg.`;pg=358;break;
 case 'ALTURA_PESO':stem=`A ${D} m de un árbol se observan ${h} cm de regla a ${d} cm del ojo. El radio del tronco es ${fmt(r2*100,0)} cm y la densidad aparente ${fmt(density,1)} kg/dm³. Con el modelo cilíndrico, ¿qué masa aproximada resulta? Usa π=3,14.`;value=vol2*density*1000;unit='kg';proof=`H=${h}×${D}/${d}=${fmt(height)} m; V=3,14×${fmt(r2)}²×H=${fmt(vol2)} m³; m=V×${fmt(density*1000,0)}=${fmt(value)} kg.`;pg=358;break;
 case 'PESO_INVERSO':{const V=pick([2.4,3.6,4.8,5.2,6.4],rng);const mass=V*density*1000;stem=`Se estima una masa de ${fmt(mass,0)} kg para un árbol con densidad aparente de ${fmt(density,1)} kg/dm³. ¿Cuál es su volumen aproximado?`;value=V;unit='m³';proof=`V = m/ρ = ${fmt(mass,0)}/(${fmt(density*1000,0)} kg/m³) = ${fmt(value)} m³.`;pg=357;break;}
 case 'DENSIDAD_INVERSA':{const V=pick([2.5,3.5,4.5,5.5],rng);const mass=V*density*1000;stem=`Un árbol tiene volumen estimado ${fmt(V,1)} m³ y masa ${fmt(mass,0)} kg. ¿Qué densidad aparente corresponde, en kg/dm³?`;value=density;unit='kg/dm³';proof=`ρ=${fmt(mass,0)}/${fmt(V,1)}=${fmt(density*1000,0)} kg/m³ = ${fmt(value,2)} kg/dm³.`;pg=357;break;}
 default:throw Error('Familia no documentada');
 }
 const digits=unit==='kg'?0:unit==='kg/dm³'?2:unit==='m'?2:2;
 const correct=Number(value.toFixed(digits));
 if(!Number.isFinite(correct)||correct<=0)throw Error('Valor no válido');
 const multipliers=[0.5,0.75,0.8,0.9,1.1,1.2,1.25,1.5,2,4];
 const used=new Set([correct]);const distractors=[];
 for(const mult of multipliers){const v=Number((value*mult).toFixed(digits));if(v>0&&!used.has(v)){used.add(v);distractors.push(v);}if(distractors.length===3)break;}
 if(distractors.length!==3)throw Error('Distractores insuficientes');
 const options=[correct,...distractors];const shift=variant%4;
 const ordered=options.slice(shift).concat(options.slice(0,shift));
 return {stem,options:ordered.map(x=>`${fmt(x,digits)} ${unit}`),correctIndex:ordered.indexOf(correct),explanation:proof+` Fuente: CEIS, página ${pg}.`,sourcePage:pg-350,manualPage:String(pg),questionFamily:'CALCULO_FORMULACION',difficulty:'muy alta',graphic:null,resetLocal136:true,mathFamily:family,mathValue:correct,mathUnit:unit};
}
function generateSet(count,rng=Math.random){const out=[];for(let i=0;i<count;i++){const family=families[i%families.length].id;out.push(generate(family,i,rng));}return out;}
module.exports={families,generate,generateSet};
