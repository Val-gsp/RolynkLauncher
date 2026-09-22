// Bake original Blockbench idle keyframes to transparent sprite atlases.
// Optional development dependencies: playwright and three; no runtime WebGL required.
const {chromium}=require('playwright');
const fs=require('fs');
const http=require('http');
const path=require('node:path');
const base=process.argv[2];
if(!base)throw new Error('Usage: node tools/render-pets.cjs <bbmodel-directory> [output-directory]');
const output=process.argv[3]||path.resolve(__dirname,'../app/assets/images/pets');
const threeBuild=path.dirname(require.resolve('three'));

const srv=http.createServer((req,res)=>{
 const name=path.basename(req.url);
 if(!['three.module.js','three.core.js'].includes(name)){res.end('{}');return;}
 try{res.setHeader('Content-Type','text/javascript');res.end(fs.readFileSync(path.join(threeBuild,name)))}catch{res.statusCode=404;res.end()}
});
(async()=>{await new Promise(r=>srv.listen(0,'127.0.0.1',r));const browser=await chromium.launch({args:['--no-sandbox']});const page=await browser.newPage({viewport:{width:600,height:600}});await page.goto(`http://127.0.0.1:${srv.address().port}/package.json`);
for(const name of ['forest_keeper','arctic_witch','meowgician']){
const model=JSON.parse(fs.readFileSync(base+'/cubee-'+name+'.bbmodel'));
const data=await page.evaluate(async model=>{
const T=await import('/three.module.js');const scene=new T.Scene();const root=new T.Group();scene.add(root);
const textures=await Promise.all(model.textures.map(t=>new T.TextureLoader().loadAsync(t.source)));textures.forEach(t=>{t.magFilter=T.NearestFilter;t.minFilter=T.NearestFilter;t.colorSpace=T.SRGBColorSpace});
const bones=new Map();
const groups=Object.fromEntries(model.groups.map(g=>[g.uuid,g]));const els=Object.fromEntries(model.elements.map(e=>[e.uuid,e]));
const corners={north:[[1,1,0],[1,0,0],[0,0,0],[0,1,0]],south:[[0,1,1],[0,0,1],[1,0,1],[1,1,1]],east:[[1,1,1],[1,0,1],[1,0,0],[1,1,0]],west:[[0,1,0],[0,0,0],[0,0,1],[0,1,1]],up:[[0,1,0],[0,1,1],[1,1,1],[1,1,0]],down:[[0,0,1],[0,0,0],[1,0,0],[1,0,1]]};
function walk(node,parent,origin=[0,0,0]){const d=typeof node==='string'?els[node]:groups[node.uuid];if(!d||d.visibility===false)return; if(/particle|effect|vfx/i.test(d.name))return;const o=d.origin||[0,0,0];const g=new T.Group();g.position.set(...o.map((v,i)=>v-origin[i]));g.rotation.set(...(d.rotation||[0,0,0]).map(v=>v*Math.PI/180),'ZYX');parent.add(g);
if(typeof node!=='string'){bones.set(node.uuid,{mesh:g,position:g.position.clone(),rotation:g.rotation.clone()});for(const c of node.children||[])walk(c,g,o);return}
for(const [face,f] of Object.entries(d.faces||{})){if(f.texture==null||!corners[face])continue;const pos=corners[face].flatMap(c=>c.map((v,i)=>d.from[i]+v*(d.to[i]-d.from[i])-o[i]));const tex=model.textures[f.texture];const w=tex.uv_width||model.resolution.width,h=tex.uv_height||model.resolution.height;const [a,b,c,e]=f.uv;let uv=[[a/w,1-b/h],[a/w,1-e/h],[c/w,1-e/h],[c/w,1-b/h]];for(let n=0;n<(f.rotation||0)/90;n++)uv.unshift(uv.pop());const geo=new T.BufferGeometry();geo.setAttribute('position',new T.Float32BufferAttribute(pos,3));geo.setAttribute('uv',new T.Float32BufferAttribute(uv.flat(),2));geo.setIndex([0,1,2,0,2,3]);geo.computeVertexNormals();g.add(new T.Mesh(geo,new T.MeshStandardMaterial({map:textures[f.texture],transparent:true,alphaTest:.1,side:T.DoubleSide,roughness:1})));}}
model.outliner.forEach(n=>walk(n,root));
const animation=model.animations.find(a=>a.name==='idle');
const fps=20,frames=Math.round(animation.length*fps),tile=320,columns=8;
function vector(k,last=false){const pts=k.data_points;const p=pts[last?pts.length-1:0];return ['x','y','z'].map(axis=>Number(p[axis]));}
function sample(keys,time){
 keys.sort((a,b)=>a.time-b.time);
 if(time<=keys[0].time)return vector(keys[0]);
 let i=keys.findIndex(k=>k.time>time);
 if(i<0)return vector(keys.at(-1),true);
 const a=keys[i-1],b=keys[i],t=(time-a.time)/(b.time-a.time),v1=vector(a,true),v2=vector(b);
 if(a.interpolation==='step')return v1;
 if(a.interpolation==='catmullrom'||b.interpolation==='catmullrom'){
  const prev=keys[i-2]||(keys.length>=3?keys.at(-2):a),next=keys[i+1]||(keys.length>=3?keys[1]:b);
  const v0=vector(prev,true),v3=vector(next);
  return v1.map((v,j)=>.5*((2*v)+(-v0[j]+v2[j])*t+(2*v0[j]-5*v+4*v2[j]-v3[j])*t*t+(-v0[j]+3*v-3*v2[j]+v3[j])*t*t*t));
 }
 return v1.map((v,j)=>v+(v2[j]-v)*t);
}
function pose(time){
 root.rotation.y=0;
 for(const [id,bone] of bones){
  const {mesh,position,rotation}=bone;mesh.position.copy(position);mesh.rotation.copy(rotation);mesh.scale.set(1,1,1);
  const anim=animation.animators[id];if(!anim)continue;
  for(const channel of ['rotation','position','scale']){
   const keys=(anim.keyframes||[]).filter(k=>k.channel===channel);
   if(keys.length){const values=sample(keys,time);
    if(channel==='rotation'){mesh.rotation.x+=values[0]*Math.PI/180;mesh.rotation.y+=values[1]*Math.PI/180;mesh.rotation.z+=values[2]*Math.PI/180;}
    if(channel==='position')mesh.position.add(new T.Vector3(...values));
    if(channel==='scale')mesh.scale.set(...values.map(v=>v||.00001));
   }
  }
  if(anim.rotation_global){const q=mesh.parent.getWorldQuaternion(new T.Quaternion()).invert();mesh.quaternion.premultiply(q);}
 }
 root.rotation.y=-.35;scene.updateMatrixWorld(true);
}
const bounds=new T.Box3();
for(let n=0;n<frames;n++){pose(n/fps);bounds.union(new T.Box3().setFromObject(root));}
const center=bounds.getCenter(new T.Vector3()),size=bounds.getSize(new T.Vector3());
// Frame every pose with a fixed camera so the animation never jitters or clips.
const span=Math.max(size.x,size.y,size.z)*.69;
const camera=new T.OrthographicCamera(-span,span,span,-span,.1,1000);
camera.position.copy(center).add(new T.Vector3(0,span*.3,-span*4));camera.lookAt(center);
scene.add(new T.HemisphereLight(0xe6ffff,0x565766,3));const light=new T.DirectionalLight(0xffffff,4);light.position.set(-20,35,-40);scene.add(light);
const renderer=new T.WebGLRenderer({alpha:true,antialias:true,preserveDrawingBuffer:true});renderer.setSize(tile,tile);
const sheet=document.createElement('canvas');sheet.width=columns*tile;sheet.height=Math.ceil(frames/columns)*tile;
const ctx=sheet.getContext('2d');let poster;
for(let n=0;n<frames;n++){pose(n/fps);renderer.render(scene,camera);ctx.drawImage(renderer.domElement,(n%columns)*tile,Math.floor(n/columns)*tile);if(n===0)poster=renderer.domElement.toDataURL('image/png');}
renderer.dispose();scene.traverse(node=>{node.geometry?.dispose();node.material?.dispose()});textures.forEach(t=>t.dispose());
return {sheet:sheet.toDataURL('image/webp',.88),poster,frames,fps,tile,columns,duration:animation.length};
},model);const dest=path.resolve(output)+path.sep;fs.mkdirSync(dest,{recursive:true});
fs.writeFileSync(dest+name+'-idle.webp',Buffer.from(data.sheet.split(',')[1],'base64'));
fs.writeFileSync(dest+name+'.png',Buffer.from(data.poster.split(',')[1],'base64'));
const {sheet,poster,...meta}=data;fs.writeFileSync(dest+name+'-idle.json',JSON.stringify(meta,null,2));console.log('Rendered idle',name,meta);
}await browser.close();srv.close()})();
