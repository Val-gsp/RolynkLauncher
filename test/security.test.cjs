'use strict'
const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const acorn = require('acorn')
const root = path.resolve(__dirname, '..')
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'rolynk-security-test-'))
const logger = { info(){}, warn(){}, error(){}, debug(){} }
const security = require('../app/assets/js/security')
after(() => {
    assert.equal(path.dirname(fixture), fs.realpathSync(os.tmpdir()))
    assert(path.basename(fixture).startsWith('rolynk-security-test-'))
    fs.rmSync(fixture, { recursive:true, force:true })
})
function load(file, mocks = {}, globals = {}) {
    const filename = path.join(root,file)
    const localRequire = createRequire(filename)
    const mod = {exports:{}}
    vm.runInNewContext(fs.readFileSync(filename,'utf8'),{module:mod,exports:mod.exports,
        Buffer,URL,AbortSignal,structuredClone,console:logger,__dirname:path.dirname(filename),
        process:{platform:process.platform,arch:process.arch},
        require:id=>Object.hasOwn(mocks,id)?mocks[id]:localRequire(id),...globals},{filename})
    return mod.exports
}
function snippet(file, name, globals) {
    const code = fs.readFileSync(path.join(root,file),'utf8')
    const fn = acorn.parse(code,{ecmaVersion:'latest'}).body.find(n=>n.type==='FunctionDeclaration'&&n.id.name===name)
    assert(fn,name)
    const context = vm.createContext({Buffer,URL,AbortSignal,console:logger,require,...globals})
    vm.runInContext(code.slice(fn.start,fn.end),context)
    return context[name]
}
test('signed distribution rejects tampering, unknown signing keys, expiry and missing signature',()=>{
    const {signDistribution}=require('../tools/sign-distribution.cjs')
    const {verify}=require('../vendor/helios-core/distribution-signature')
    const key=crypto.generateKeyPairSync('ed25519')
    const trust={minimumSequence:2,publicKey:key.publicKey}
    const signed=signDistribution({servers:[]},key.privateKey,2)
    assert.equal(verify(signed,trust),signed)
    assert.throws(()=>verify({...signed,servers:[{}]},trust),/signature/)
    assert.throws(()=>verify(signed,{...trust,publicKey:crypto.generateKeyPairSync('ed25519').publicKey}),/signature/)
    assert.throws(()=>verify(signed,trust,Date.now()+32*86400000),/expired/)
    assert.throws(()=>verify(signDistribution({},key.privateKey,1),trust),/metadata/)
    assert.throws(()=>verify({servers:[]},trust))
})
test('artifact paths reject traversal and Windows drive/UNC paths',()=>{
    for(const file of ['../escape','a/../../escape','C:\\escape','\\\\server\\file','a/./b','a:stream','/absolute']) {
        assert.throws(()=>security.containedPath(fixture,file))
    }
    const {HeliosModule}=require('helios-core/common')
    assert.throws(()=>new HeliosModule({id:'test',type:'File',artifact:{path:'../../escape'}},'test',fixture,fixture))
})
test('cleanup refuses a junction and preserves external canary',()=>{
    const owned=path.join(fixture,'owned'),outside=path.join(fixture,'outside')
    fs.mkdirSync(owned);fs.mkdirSync(outside)
    const canary=path.join(outside,'canary')
    fs.writeFileSync(canary,'unchanged')
    const link=path.join(owned,'link')
    fs.symlinkSync(outside,link,process.platform==='win32'?'junction':'dir')
    assert.throws(()=>security.removeOwnedFiles(owned,[path.join(link,'canary')]))
    assert.equal(fs.readFileSync(canary,'utf8'),'unchanged')
    fs.unlinkSync(link)
})
for(const sameSize of [true,false]) test('corrupt downloads never commit or report completion (sameSize='+sameSize+')',async()=>{
    const messages=[];let post=0;let checks=0
    const {FullRepairReceiver}=load('node_modules/helios-core/dist/dl/receivers/FullRepairReceiver.js',{
        '../DownloadEngine':{getExpectedDownloadSize:()=>4,downloadQueue:async()=>({item:sameSize?4:5})},
        '../../common/util/FileUtils':{validateLocalFile:async()=>{checks++;return false}},
        '../../util/LoggerUtil':{LoggerUtil:{getLogger:()=>logger}}
    },{process:{send:m=>messages.push(m)}})
    const receiver=new FullRepairReceiver()
    receiver.assets=[{id:'item',size:4,hash:'bad',algo:'sha256',path:path.join(fixture,'download')}]
    receiver.processors=[{postDownload:async()=>post++}]
    await assert.rejects(receiver.download({}),/integrity/)
    assert.equal(post,0)
    assert(!messages.some(m=>m.response==='downloadComplete'))
    assert.equal(checks,sameSize?1:0)
})
test('same-size corrupt JDK is never extracted',async()=>{
    let extracted=false;let checked=false
    const fn=snippet('app/assets/js/scripts/landing.js','downloadJava',{
        latestOpenJDK:async()=>({url:'https://example.invalid/jdk',path:path.join(fixture,'jdk'),size:4,hash:'bad',algo:'sha256'}),
        ConfigManager:{getDataDirectory:()=>fixture},fs:require('fs-extra'),
        downloadFile:async(_u,_p,cb)=>cb({transferred:4}),setDownloadPercentage(){},loggerLanding:logger,
        validateLocalFile:async()=>{checked=true;return false},Lang:{queryJS:x=>x},
        extractJdk:async()=>{extracted=true}
    })
    await assert.rejects(fn({suggestedMajor:21},false))
    assert(checked);assert.equal(extracted,false)
})
test('OS keyring is required; basic_text is refused',()=>{
    assert.equal(security.protectedStorage(null),false)
    assert.equal(security.protectedStorage({isEncryptionAvailable:()=>true,getSelectedStorageBackend:()=> 'basic_text'}),false)
    assert.equal(security.protectedStorage({isEncryptionAvailable:()=>true}),true)
})
test('vault removes clear cache, reuses verified ciphertext and cleans partial extraction',()=>{
    let keySeal=null
    const config={getDeviceId:()=> 'fixture',getDataDirectory:()=>fixture,getInstanceDirectory:()=>path.join(fixture,'instances'),
        getCommonDirectory:()=>path.join(fixture,'common'),getVaultKeySeal:()=>keySeal,setVaultKeySeal:v=>{keySeal=v},save(){}}
    const vault=load('app/assets/js/modvault.js',{'./configmanager':config,
        '@electron/remote':{safeStorage:{isEncryptionAvailable:()=>true,encryptString:x=>Buffer.from(x),decryptString:x=>x.toString()}},
        'helios-core':{LoggerUtil:{getLogger:()=>logger}}})
    const PB=load('app/assets/js/processbuilder.js',{'./configmanager':config,'./modvault':vault,'./securelog':{getSecureLogger:()=>logger}})
    const cache=path.join(config.getInstanceDirectory(),'instance','.rt-cache','fixture.dat')
    fs.mkdirSync(path.dirname(cache),{recursive:true})
    const bytes=Buffer.from('harmless test content')
    fs.writeFileSync(cache,bytes)
    const module={rawModule:{id:'fixture',type:'File',artifact:{path:'.rt-cache/fixture.dat',size:bytes.length,
        SHA256:crypto.createHash('sha256').update(bytes).digest('hex')}},getPath:()=>cache,subModules:[]}
    const pb=new PB({rawServer:{id:'instance'},modules:[module]},{},{},{},'test')
    pb._materializeVaultedMods()
    assert.equal(fs.existsSync(cache),false)
    assert.equal(vault.verifiedCachedAssets([module]).length,1)
    const mods=path.join(pb.gameDir,'mods')
    security.removeOwnedFiles(mods,pb.materializedVaultFiles)
    pb._materializeVaultedMods()
    assert.equal(fs.readFileSync(pb.materializedVaultFiles[0],'utf8'),bytes.toString())
    security.removeOwnedFiles(mods,pb.materializedVaultFiles)
    assert.throws(()=>vault.unsealInto([{vaultId:vault.vaultIdFor('fixture')},{vaultId:'missing'}],mods))
    assert.equal(fs.readdirSync(mods).length,0)
    assert.equal(keySeal.enc,true)
})
test('nested secrets and launch tokens are redacted without invoking getters',()=>{
    const {redact}=require('../app/assets/js/securelog')
    const data={nested:{token:'short-secret'},args:['--accessToken','short-secret'],url:'https://example.invalid/?secret=1',
        get dangerous(){throw new Error('must not run')}}
    data.circular=data
    const result=redact(data)
    assert.equal(result.nested.token,'[redacted]')
    assert.equal(result.args[1],'[redacted]')
    assert.equal(result.dangerous,'[accessor]')
    assert.equal(result.circular,'[circular]')
    assert(!JSON.stringify(result).includes('short-secret'))
})
test('premium link and launch OTP include bearer proof; expired session is refused',async()=>{
    const calls=[]
    const auth=load('app/assets/js/rolynkauth.js',{'./configmanager':{getDeviceId:()=> 'fixture',getOtpTrust:()=>null},
        'helios-core':{LoggerUtil:{getLogger:()=>logger}}},{fetch:async(url,opts)=>{calls.push(opts);return{status:401,json:async()=>({})}}})
    await auth.premiumLinkStatus('uuid','name','fixture-token')
    await auth.requestLaunchOtp('premium','uuid','name','fixture-token')
    assert(calls.every(c=>c.headers.Authorization==='Bearer fixture-token'))
    assert.equal(await auth.validateAccount({uuid:'uuid',rolynk:{sessionToken:null}}),false)
})
test('wrong checkout callback preserves pending checkout; success requires server delivery',async()=>{
    const account={uuid:'fixture',type:'microsoft'}
    const pending=JSON.stringify({sessionId:'cs_test_fixture',accountUuid:account.uuid,accountType:account.type,itemId:'big',createdAt:Date.now()})
    let stored=pending;let status='pending';let calls=0
    const fn=snippet('app/assets/js/scripts/landing.js','consumeVerifiedPendingCheckout',{
        ConfigManager:{getSelectedAccount:()=>account},
        localStorage:{getItem:()=>stored,removeItem:()=>{stored=null}},
        PENDING_CHECKOUT_STORAGE_KEY:'test',PENDING_CHECKOUT_MAX_AGE_MS:7200000,PAYMENT_API_BASE:'https://example.invalid',
        subscriptionAuthHeaders:()=>({Authorization:'Bearer fixture'}),setTimeout:cb=>cb(),
        fetch:async()=>{calls++;return{ok:true,json:async()=>({status,sessionId:'cs_test_fixture',itemId:'big'})}}
    })
    assert.equal(await fn('wrong'),null);assert.equal(stored,pending);assert.equal(calls,0)
    assert.equal(await fn('cs_test_fixture'),null);assert.equal(stored,pending)
    status='paid'
    assert.equal(await fn('cs_test_fixture'),'big');assert.equal(stored,null)
})
test('Rolynk logout uses its own provider and retains account on revocation failure',async()=>{
    let removed=false;let fail=true;let correct=0
    const parent={getAttribute:()=> 'fixture',remove:()=>{removed=true}}
    const fn=snippet('app/assets/js/scripts/settings.js','processLogOut',{
        ConfigManager:{getSelectedAccount:()=>({uuid:'other'}),getAuthAccount:()=>({type:'rolynk'})},
        AuthManager:{removeRolynkAccount:async()=>{correct++;if(fail)throw new Error('offline')},removeMojangAccount:()=>{throw new Error('wrong provider')}},
        $:()=>({fadeOut:(_time,callback)=>callback()}),setOverlayContent(){},setOverlayHandler(){},toggleOverlay(){}
    })
    fn({closest:()=>parent},false);await new Promise(resolve=>setImmediate(resolve))
    assert.equal(removed,false)
    fail=false
    fn({closest:()=>parent},false);await new Promise(resolve=>setImmediate(resolve))
    assert.equal(removed,true);assert.equal(correct,2)
})
test('external checkout URLs reject schemes, credentials and lookalike hosts',()=>{
    for(const url of ['file:///tmp/test','javascript:alert(1)','https://checkout.stripe.com.evil.invalid/x','https://user@checkout.stripe.com/x'])
        assert.throws(()=>security.checkedHttpsUrl(url,['checkout.stripe.com']))
    assert.equal(security.checkedHttpsUrl('https://checkout.stripe.com/x',['checkout.stripe.com']),'https://checkout.stripe.com/x')
})
test('OAuth callback binds exact origin/path and unpredictable single state',()=>{
    const redirect='https://login.microsoftonline.com/common/oauth2/nativeclient'
    const state=crypto.randomBytes(32).toString('base64url')
    assert.equal(security.oauthCallback(redirect+'?code=fixture&state='+state,redirect,state).code,'fixture')
    for(const uri of [redirect+'?code=fixture',redirect+'?code=fixture&state=wrong',
        redirect+'?code=fixture&state='+state+'&state='+state,
        'https://evil.invalid/common/oauth2/nativeclient?code=fixture&state='+state,
        redirect+'/fake?code=fixture&state='+state])
        assert.equal(security.oauthCallback(uri,redirect,state),null)
})
