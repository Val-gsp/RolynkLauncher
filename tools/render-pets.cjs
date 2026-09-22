// Bake the original Blockbench animations (idle, pet, ultimate) to transparent sprite atlases.
// Optional development dependencies: playwright and three; no runtime WebGL required.
//
// Every animation of a pet shares the idle camera and pixel scale: `rect` locates each atlas
// relative to the idle tile, so the launcher can switch animations without the pet jumping.
// Ultimates deploy the `allef` effect aura (hidden otherwise, as CubeeModel does in the mod) and
// reach far outside the idle frame, so they are baked at a lower density and frame rate.
const {chromium}=require('playwright');
const fs=require('fs');
const http=require('http');
const path=require('node:path');
const base=process.argv[2];
if(!base)throw new Error('Usage: node tools/render-pets.cjs <bbmodel-directory> [output-directory]');
const output=path.resolve(process.argv[3]||path.resolve(__dirname,'../app/assets/images/pets'));
const threeBuild=path.dirname(require.resolve('three'));
const PETS=['forest_keeper','arctic_witch','meowgician'];
// maxExtent: furthest reach outside the idle tile, in idle tiles. budget: atlas pixel cap.
const ANIMATIONS={
 idle:{fps:20,maxExtent:0,budget:16e6},
 pet:{fps:20,maxExtent:.35,budget:12e6},
 ultimate:{fps:15,maxExtent:.6,budget:22e6}
};
const TILE=320;

const srv=http.createServer((req,res)=>{
 const name=path.basename(req.url);
 if(!['three.module.js','three.core.js'].includes(name)){res.end('{}');return;}
 try{res.setHeader('Content-Type','text/javascript');res.end(fs.readFileSync(path.join(threeBuild,name)))}catch{res.statusCode=404;res.end()}
});

async function bake(page,model,animations,tile){
 return page.evaluate(async({model,animations,tile})=>{
  const T=await import('/three.module.js');
  const scene=new T.Scene();const root=new T.Group();scene.add(root);
  const textures=await Promise.all(model.textures.map(t=>new T.TextureLoader().loadAsync(t.source)));
  textures.forEach(t=>{t.magFilter=T.NearestFilter;t.minFilter=T.NearestFilter;t.colorSpace=T.SRGBColorSpace});
  const bones=new Map();let aura=null;
  const groups=Object.fromEntries(model.groups.map(g=>[g.uuid,g]));const els=Object.fromEntries(model.elements.map(e=>[e.uuid,e]));
  const corners={north:[[1,1,0],[1,0,0],[0,0,0],[0,1,0]],south:[[0,1,1],[0,0,1],[1,0,1],[1,1,1]],east:[[1,1,1],[1,0,1],[1,0,0],[1,1,0]],west:[[0,1,0],[0,0,0],[0,0,1],[0,1,1]],up:[[0,1,0],[0,1,1],[1,1,1],[1,1,0]],down:[[0,0,1],[0,0,0],[1,0,0],[1,0,1]]};
  // VFX textures are drawn unlit so the ultimate effects glow like light sources.
  const materials=textures.map((map,i)=>/vfx/i.test(model.textures[i].name)
   ?new T.MeshBasicMaterial({map,transparent:true,alphaTest:.1,side:T.DoubleSide})
   :new T.MeshStandardMaterial({map,transparent:true,alphaTest:.1,side:T.DoubleSide,roughness:1}));
  function walk(node,parent,origin=[0,0,0]){
   const d=typeof node==='string'?els[node]:groups[node.uuid];
   // Blockbench's editor-only visibility flag is ignored, as in the mod (which hides `allef` itself).
   if(!d||d.name==='hitbox'||/particle|effect/i.test(d.name))return;
   const o=d.origin||[0,0,0];const g=new T.Group();
   g.position.set(...o.map((v,i)=>v-origin[i]));g.rotation.set(...(d.rotation||[0,0,0]).map(v=>v*Math.PI/180),'ZYX');parent.add(g);
   if(typeof node!=='string'){
    if(d.name==='allef')aura=g;
    bones.set(node.uuid,{mesh:g,position:g.position.clone(),rotation:g.rotation.clone()});
    for(const c of node.children||[])walk(c,g,o);return;
   }
   for(const [face,f] of Object.entries(d.faces||{})){
    if(f.texture==null||!corners[face])continue;
    const pos=corners[face].flatMap(c=>c.map((v,i)=>d.from[i]+v*(d.to[i]-d.from[i])-o[i]));
    const tex=model.textures[f.texture];const w=tex.uv_width||model.resolution.width,h=tex.uv_height||model.resolution.height;
    const [a,b,c,e]=f.uv;let uv=[[a/w,1-b/h],[a/w,1-e/h],[c/w,1-e/h],[c/w,1-b/h]];
    for(let n=0;n<(f.rotation||0)/90;n++)uv.unshift(uv.pop());
    const geo=new T.BufferGeometry();geo.setAttribute('position',new T.Float32BufferAttribute(pos,3));geo.setAttribute('uv',new T.Float32BufferAttribute(uv.flat(),2));geo.setIndex([0,1,2,0,2,3]);geo.computeVertexNormals();
    g.add(new T.Mesh(geo,materials[f.texture]));
   }
  }
  model.outliner.forEach(n=>walk(n,root));

  function vector(k,last=false){const pts=k.data_points;const p=pts[last?pts.length-1:0];return ['x','y','z'].map(axis=>Number(p[axis]));}
  function sample(keys,time){
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
  function pose(animation,time){
   for(const [id,bone] of bones){
    const {mesh,position,rotation}=bone;mesh.position.copy(position);mesh.rotation.copy(rotation);mesh.scale.set(1,1,1);
    const anim=animation.animators[id];if(!anim)continue;
    for(const channel of ['rotation','position','scale']){
     const keys=(anim.keyframes||[]).filter(k=>k.channel===channel).sort((a,b)=>a.time-b.time);
     if(!keys.length)continue;
     const values=sample(keys,time);
     if(channel==='rotation'){mesh.rotation.x+=values[0]*Math.PI/180;mesh.rotation.y+=values[1]*Math.PI/180;mesh.rotation.z+=values[2]*Math.PI/180;}
     if(channel==='position')mesh.position.add(new T.Vector3(...values));
     if(channel==='scale')mesh.scale.set(...values.map(v=>v||.00001));
    }
    if(anim.rotation_global){const q=mesh.parent.getWorldQuaternion(new T.Quaternion()).invert();mesh.quaternion.premultiply(q);}
   }
   root.rotation.y=-.35;scene.updateMatrixWorld(true);
  }
  // Visible, non-collapsed vertices only: scale-0 bones would otherwise stretch the bounds.
  function eachVertex(fn){
   const v=new T.Vector3();
   root.traverseVisible(node=>{
    if(!node.isMesh||Math.abs(node.matrixWorld.determinant())<1e-9)return;
    const p=node.geometry.attributes.position;
    for(let i=0;i<p.count;i++)fn(v.fromBufferAttribute(p,i).applyMatrix4(node.matrixWorld));
   });
  }
  const find=name=>model.animations.find(a=>a.name===name);
  const setup=(name,fps)=>{const animation=find(name);if(aura)aura.visible=name==='ultimate';return {animation,frames:Math.round(animation.length*fps)};};

  // One camera frames the whole idle cycle, exactly as before.
  const idle=setup('idle',animations.idle.fps);
  const bounds=new T.Box3();
  for(let n=0;n<idle.frames;n++){pose(idle.animation,n/animations.idle.fps);eachVertex(v=>bounds.expandByPoint(v));}
  const center=bounds.getCenter(new T.Vector3()),size=bounds.getSize(new T.Vector3());
  const span=Math.max(size.x,size.y,size.z)*.69;
  const camera=new T.OrthographicCamera(-span,span,span,-span,.1,1000);
  camera.position.copy(center).add(new T.Vector3(0,span*.3,-span*4));camera.lookAt(center);camera.updateMatrixWorld(true);
  scene.add(new T.HemisphereLight(0xe6ffff,0x565766,3));const light=new T.DirectionalLight(0xffffff,4);light.position.set(-20,35,-40);scene.add(light);
  const renderer=new T.WebGLRenderer({alpha:true,antialias:true,preserveDrawingBuffer:true});

  const result={};
  for(const [name,opt] of Object.entries(animations)){
   const {animation,frames}=setup(name,opt.fps);
   // Screen extent of the whole cycle in idle NDC, grown past the idle tile up to maxExtent.
   let x0=-1,x1=1,y0=-1,y1=1;const limit=1+2*opt.maxExtent;
   for(let n=0;n<frames;n++){pose(animation,n/opt.fps);eachVertex(v=>{v.project(camera);x0=Math.min(x0,v.x);x1=Math.max(x1,v.x);y0=Math.min(y0,v.y);y1=Math.max(y1,v.y);});}
   [x0,y0]=[x0,y0].map(v=>Math.max(v,-limit));[x1,y1]=[x1,y1].map(v=>Math.min(v,limit));
   // Snap to whole idle pixels so the atlas lines up with the idle tile.
   const snap=v=>Math.round(v*tile/2)*2/tile;[x0,x1,y0,y1]=[x0,x1,y0,y1].map(snap);
   const fullW=(x1-x0)/2*tile,fullH=(y1-y0)/2*tile;
   const density=Math.min(1,Math.sqrt(opt.budget/(fullW*fullH*frames)));
   const width=Math.round(fullW*density),height=Math.round(fullH*density);
   const columns=Math.max(1,Math.min(frames,Math.floor(8192/width)));
   const cam=new T.OrthographicCamera(span*x0,span*x1,span*y1,span*y0,.1,1000);cam.position.copy(camera.position);cam.quaternion.copy(camera.quaternion);
   renderer.setSize(width,height);
   const sheet=document.createElement('canvas');sheet.width=columns*width;sheet.height=Math.ceil(frames/columns)*height;
   const ctx=sheet.getContext('2d');let poster=null;
   for(let n=0;n<frames;n++){pose(animation,n/opt.fps);renderer.render(scene,cam);ctx.drawImage(renderer.domElement,(n%columns)*width,Math.floor(n/columns)*height);if(n===0&&name==='idle')poster=renderer.domElement.toDataURL('image/png');}
   result[name]={sheet:sheet.toDataURL('image/webp',.86),poster,meta:{frames,fps:opt.fps,width,height,columns,duration:animation.length,loop:animation.loop==='loop',
    rect:{x:(x0+1)/2,y:(1-y1)/2,w:(x1-x0)/2,h:(y1-y0)/2}}};
  }
  renderer.dispose();scene.traverse(node=>node.geometry?.dispose());materials.forEach(m=>m.dispose());textures.forEach(t=>t.dispose());
  return result;
 },{model,animations,tile});
}

(async()=>{
 await new Promise(r=>srv.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({args:['--no-sandbox']});
 try{
  const page=await browser.newPage({viewport:{width:600,height:600}});
  await page.goto(`http://127.0.0.1:${srv.address().port}/package.json`);
  fs.mkdirSync(output,{recursive:true});
  for(const name of PETS){
   const model=JSON.parse(fs.readFileSync(path.join(base,'cubee-'+name+'.bbmodel')));
   const baked=await bake(page,model,ANIMATIONS,TILE);
   const meta={};
   for(const [anim,data] of Object.entries(baked)){
    fs.writeFileSync(path.join(output,`${name}-${anim}.webp`),Buffer.from(data.sheet.split(',')[1],'base64'));
    if(data.poster)fs.writeFileSync(path.join(output,name+'.png'),Buffer.from(data.poster.split(',')[1],'base64'));
    meta[anim]=data.meta;
   }
   fs.writeFileSync(path.join(output,name+'.json'),JSON.stringify(meta,null,2));
   console.log('Rendered',name,Object.fromEntries(Object.entries(meta).map(([k,m])=>[k,`${m.frames}f ${m.width}x${m.height} rect ${JSON.stringify(m.rect)}`])));
  }
 }finally{await browser.close();srv.close()}
})();
