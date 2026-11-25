import assert from 'node:assert/strict';
import {createAuthHandler,createStoreAccess} from '../server/auth.js';
const env={AUTH_DATABASE_URL:'file::memory:',AUTH_JWT_SECRET:'test-only-secret-at-least-32-characters',AUTH_FIREBASE_API_KEY:'test'};
const store=createStoreAccess(env,false);
const auth=createAuthHandler(env,false,store);
const originalFetch=globalThis.fetch;
const google=(id,email,extra={})=>({localId:id,email,emailVerified:true,displayName:'Google Customer',providerUserInfo:[{providerId:'google.com'}],...extra});
const identities={
 'valid-a':google('google-a','customer-a@example.test'),
 'valid-b':google('google-b','customer-b@example.test'),
 'collision':google('different-id','customer-a@example.test'),
 'unverified':google('unverified','unverified@example.test',{emailVerified:false}),
 'disabled':google('disabled','disabled@example.test',{disabled:true}),
 'wrong-provider':google('other','other@example.test',{providerUserInfo:[{providerId:'password'}]}),
};
globalThis.fetch=async(url,options)=>{
 assert.ok(String(url).includes('identitytoolkit.googleapis.com/v1/accounts:lookup'));
 const identity=identities[JSON.parse(options.body).idToken];
 return identity?Response.json({users:[identity]}):Response.json({error:{message:'INVALID_ID_TOKEN'}},{status:400});
};
async function request(body,cookie='',url='/api/auth'){
 let status=200,result;const headers={};
 await auth({url,method:body?'POST':'GET',body,headers:{host:'localhost',origin:'http://localhost','content-type':'application/json',cookie},socket:{remoteAddress:'test'}},
 {setHeader:(k,v)=>headers[k]=v,set statusCode(v){status=v},end:value=>{result=JSON.parse(value)}});
 return {status,result,cookie:headers['Set-Cookie']?.split(';')[0]};
}
try{
 for(const token of ['forged','unverified','disabled','wrong-provider'])assert.equal((await request({action:'google-sign-in',idToken:token})).status,401);
 const a=await request({action:'google-sign-in',idToken:'valid-a',name:'Injected Name',order_staff:true,id:'admin'});
 assert.equal(a.status,200);assert.equal(a.result.user.name,'Google Customer');assert.equal(a.result.user.order_staff,false);
 assert.equal(a.result.user.sign_in_provider,'google');assert.match(a.cookie,/^sparkdv_session=/);
 assert.equal((await request(null,a.cookie)).result.user.sign_in_provider,'google');
 const b=await request({action:'google-sign-in',idToken:'valid-b'});
 assert.equal(b.status,200);assert.notEqual(a.result.user.id,b.result.user.id);
 assert.equal((await request({action:'google-sign-in',idToken:'collision'})).status,409);
 await request({action:'update-profile',name:'My saved name'},a.cookie);
 const repeat=await request({action:'google-sign-in',idToken:'valid-a'});
 assert.equal(repeat.result.user.id,a.result.user.id);assert.equal(repeat.result.user.name,'My saved name');
 assert.equal((await request({action:'google-sign-in',idToken:'valid-a'},'', '/pipeline/api/auth')).status,403);
 assert.equal((await request(null,a.cookie,'/pipeline/api/auth')).result.user,null);
 const {rows}=await (await store()).db.execute('SELECT id FROM auth_users');
 assert.equal(rows.length,2);
 console.log('PASS: Google token verification, verified-email/provider checks, disabled-account rejection, no client-side role escalation, UID reuse, email collision protection, provider persistence and Pipeline isolation.');
}finally{globalThis.fetch=originalFetch;(await store()).db.close();}
