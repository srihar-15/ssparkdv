import {build} from 'esbuild';
import {chromium,expect} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
await mkdir('.tmp',{recursive:true});
await build({
 stdin:{contents:"import React from 'react';import{createRoot}from'react-dom/client';import PhoneLogin from './src/components/ui/phone-login';createRoot(document.getElementById('root')).render(React.createElement(PhoneLogin));",resolveDir:process.cwd(),loader:'tsx'},
 outfile:'.tmp/phone-harness.js',bundle:true,format:'iife',define:{'process.env.NODE_ENV':'"production"'},jsx:'automatic',
 plugins:[{name:'fake-sms-only-for-tests',setup(b){
 b.onResolve({filter:/^(firebase\/auth|\.\.\/\.\.\/lib\/firebase|\.\.\/auth-provider)$/},args=>({path:args.path,namespace:'fake'}));
 b.onLoad({filter:/.*/,namespace:'fake'},args=>({loader:'js',contents:
 args.path==='../../lib/firebase'?'export const firebaseApp={};':
 args.path==='../auth-provider'?"export function useAuth(){return{changeSession:async(action,fields)=>{window.accepted={action,fields}}}}":
 `const used=new WeakSet();window.smsAttempts=0;export const inMemoryPersistence={};export const getAuth=()=>({});export const setPersistence=async()=>{};export const signOut=async()=>{};
 export class RecaptchaVerifier{constructor(auth,element){this.element=element;}clear(){this.element.replaceChildren();}}
 export async function signInWithPhoneNumber(auth,phone,verifier){
 if(used.has(verifier.element))throw Error('reCAPTCHA has already been rendered in this element');
 used.add(verifier.element);verifier.element.appendChild(document.createElement('iframe'));window.smsAttempts++;
 await new Promise(r=>setTimeout(r,20));
 if(window.smsAttempts===1)throw Object.assign(Error('failed'),{code:'auth/network-request-failed'});
 return {confirm:async code=>{if(code!=='123456')throw Object.assign(Error('invalid'),{code:'auth/invalid-verification-code'});return{user:{getIdToken:async()=>'verified-test-token'}}}};
 }`
 }));
 }}]
});
const browser=await chromium.launch({channel:'msedge'});
try{
 const page=await browser.newPage();await page.setContent('<div id="root"></div>');
 await page.addScriptTag({path:'.tmp/phone-harness.js'});
 await page.locator('#otp-name').fill('Test Customer');await page.locator('#otp-phone').fill('+919900000001');
 await page.getByRole('button',{name:'Send OTP',exact:true}).click();
 await expect(page.getByRole('alert')).toContainText('connection');
 await page.getByRole('button',{name:'Send OTP',exact:true}).click();
 await expect(page.locator('#otp-code')).toBeVisible();
 await expect(page.getByText('reCAPTCHA has already')).toHaveCount(0);
 await page.locator('#otp-code').fill('111111');await page.getByRole('button',{name:'Verify & sign in'}).click();
 await expect(page.getByRole('alert')).toContainText('incorrect');
 await page.locator('#otp-code').fill('123456');await page.getByRole('button',{name:'Verify & sign in'}).click();
 await expect.poll(()=>page.evaluate(()=>window.accepted?.action)).toBe('phone-sign-in');
 await expect.poll(()=>page.evaluate(()=>window.smsAttempts)).toBe(2);
 console.log('PASS: failed SMS attempt followed by retry uses a fresh reCAPTCHA element; invalid OTP can be retried; verified token reaches server session exchange. SMS mocked, none sent.');
}finally{await browser.close();}
