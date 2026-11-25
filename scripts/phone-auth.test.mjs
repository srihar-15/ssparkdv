import assert from 'node:assert/strict';
import {createAuthHandler,createStoreAccess} from '../server/auth.js';
import {createOrdersHandler} from '../server/orders.js';
const env={AUTH_DATABASE_URL:'file::memory:',AUTH_JWT_SECRET:'test-only-secret-at-least-32-characters',AUTH_FIREBASE_API_KEY:'test'};
const store=createStoreAccess(env,false);
const auth=createAuthHandler(env,false,store);
const orders=createOrdersHandler(env,false,store);
const originalFetch=globalThis.fetch;
const identities={
 'verified-a':{localId:'customer-a',phoneNumber:'+919900000001'},
 'verified-b':{localId:'customer-b',phoneNumber:'+919900000002'},
 'collision':{localId:'customer-c',phoneNumber:'+919900000001'},
};
globalThis.fetch=async(url,options)=>{
 if(!String(url).includes('identitytoolkit.googleapis.com'))throw Error('Unexpected network request');
 const input=JSON.parse(options.body);
 if(String(url).includes('signInWithPassword'))return Response.json({localId:'ZKhCji5uItQS8DUJgEcADzZEz8W2',email:'admin@sparkdv.invalid'});
 const identity=identities[input.idToken];
 return identity?Response.json({users:[identity]}):Response.json({error:{message:'INVALID_ID_TOKEN'}},{status:400});
};
async function request(handler,url,body,cookie=''){
 let status=200,result;const headers={};
 const req={url,method:body?'POST':'GET',body,headers:{host:'localhost',origin:'http://localhost','content-type':'application/json',cookie},socket:{remoteAddress:'test'}};
 await handler(req,{setHeader:(k,v)=>headers[k]=v,set statusCode(v){status=v},end:value=>{result=JSON.parse(value)}});
 return {status,result,cookie:headers['Set-Cookie']?.split(';')[0]};
}
try{
 assert.equal((await request(auth,'/api/auth',{action:'phone-sign-in',idToken:'forged',name:'A'})).status,401);
 const a=await request(auth,'/api/auth',{action:'phone-sign-in',idToken:'verified-a',name:'Customer A'});
 const b=await request(auth,'/api/auth',{action:'phone-sign-in',idToken:'verified-b',name:'Customer B'});
 assert.equal(a.status,200);assert.equal(b.status,200);
 assert.notEqual(a.result.user.id,b.result.user.id);assert.equal(a.result.user.order_staff,false);
 assert.equal((await request(auth,'/api/auth',{action:'phone-sign-in',idToken:'collision',name:'Takeover'})).status,409);
 assert.equal((await request(auth,'/pipeline/api/auth',{action:'phone-sign-in',idToken:'verified-a',name:'A'})).status,403);
 const staff=await request(auth,'/pipeline/api/auth',{action:'sign-in',identifier:'admin',password:'test-password'});
 assert.match(staff.cookie,/^sparkdv_staff_session=/);
 const both=a.cookie+'; '+staff.cookie;
 assert.equal((await request(auth,'/api/auth',null,both)).result.user.id,'customer-a');
 assert.equal((await request(auth,'/pipeline/api/auth',null,both)).result.user.order_staff,true);
 assert.equal((await request(auth,'/pipeline/api/auth',null,a.cookie)).result.user,null);
 await request(auth,'/api/auth',{action:'update-profile',name:'New A',id:'customer-b'},a.cookie);
 assert.equal((await request(auth,'/api/auth',null,b.cookie)).result.user.name,'Customer B');
 const placed=await request(orders,'/api/orders',{action:'place',id:'11111111-1111-4111-8111-111111111111',items:[{slug:'nanion-lite',qty:1}]},a.cookie);
 assert.equal(placed.status,201);
 assert.equal((await request(orders,'/api/orders?id=11111111-1111-4111-8111-111111111111',null,b.cookie)).status,404);
 assert.equal((await request(orders,'/api/orders?staff=1',null,b.cookie)).status,403);
 assert.equal((await request(orders,'/pipeline/api/orders?staff=1',null,both)).status,200);
 console.log('PASS: verified phone identities, token rejection, account collision protection, customer/staff cookie isolation, self-only profile updates and order ownership.');
}finally{globalThis.fetch=originalFetch;(await store()).db.close();}
