import { useEffect, useRef, useState, type FormEvent } from 'react';
import { getAuth, setPersistence, inMemoryPersistence, RecaptchaVerifier, signInWithPhoneNumber, signOut, type ConfirmationResult } from 'firebase/auth';
import { firebaseApp } from '../../lib/firebase';
import { useAuth } from '../auth-provider';

const messages: Record<string,string> = {
 'auth/invalid-phone-number':'Enter a valid mobile number with country code.',
 'auth/invalid-verification-code':'That code is incorrect. Please try again.',
 'auth/code-expired':'This code has expired. Request a new code.',
 'auth/too-many-requests':'Too many attempts. Please wait before trying again.',
 'auth/quota-exceeded':'SMS delivery is temporarily unavailable. Try password sign-in or contact support.',
 'auth/billing-not-enabled':'SMS sign-in is not yet available. Please use password sign-in.',
 'auth/operation-not-allowed':'SMS sign-in is not yet enabled. Please use password sign-in.',
 'auth/unauthorized-domain':'SMS sign-in is not configured for this website yet.',
 'auth/captcha-check-failed':'Security verification failed. Please try again.',
 'auth/network-request-failed':'Check your connection and try again.',
};
export default function PhoneLogin() {
 const {changeSession}=useAuth();
 const [phone,setPhone]=useState('');
 const [name,setName]=useState('');
 const [code,setCode]=useState('');
 const [confirmation,setConfirmation]=useState<ConfirmationResult|null>(null);
 const [pending,setPending]=useState(false);
 const [error,setError]=useState('');
 const [cooldown,setCooldown]=useState(0);
 const captcha=useRef<HTMLDivElement>(null);
 const verifier=useRef<RecaptchaVerifier|null>(null);
 const sending=useRef(false);
 const mounted=useRef(true);
 function clearCaptcha() {
   verifier.current?.clear();
   verifier.current=null;
   captcha.current?.replaceChildren();
 }
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;clearCaptcha();};},[]);
 useEffect(()=>{if(!cooldown)return;const timer=setTimeout(()=>setCooldown(n=>Math.max(0,n-1)),1000);return()=>clearTimeout(timer);},[cooldown]);
 function failure(err: unknown) {
   const e=err as {code?:string;message?:string};
   setError(e.code ? messages[e.code] || 'Unable to verify your number. Please try again.' : e.message || 'Please try again.');
 }
 async function sendCode() {
   if(pending||cooldown||sending.current)return;
   let mobile=phone.replace(/[\s()-]/g,'');
   if(/^\d{10}$/.test(mobile))mobile='+91'+mobile;
   if(!/^\+[1-9]\d{7,14}$/.test(mobile)){setError('Enter a valid mobile number, including country code.');return;}
   if(!name.trim()){setError('Enter your name.');return;}
   sending.current=true;setPending(true);setError('');
   try{
     const auth=getAuth(firebaseApp);await setPersistence(auth,inMemoryPersistence);
     if(!mounted.current||!captcha.current)return;
     clearCaptcha();
     // reCAPTCHA remembers its rendered element even after clear/reset.
     // Give every attempt a new element, never the React-owned wrapper.
     const challenge=document.createElement('div');
     captcha.current.appendChild(challenge);
     verifier.current=new RecaptchaVerifier(auth,challenge,{size:'invisible'});
     const result=await signInWithPhoneNumber(auth,mobile,verifier.current);
     if(!mounted.current)return;
     setPhone(mobile);setConfirmation(result);setCode('');setCooldown(60);
   }catch(err){clearCaptcha();if(mounted.current)failure(err);}
   finally{sending.current=false;if(mounted.current)setPending(false);}
 }
 async function submit(event:FormEvent) {
   event.preventDefault();
   if(!confirmation){await sendCode();return;}
   if(pending)return;
   if(!/^\d{6}$/.test(code)){setError('Enter the 6-digit SMS code.');return;}
   setPending(true);setError('');
   try{
     const credential=await confirmation.confirm(code);
     try{await changeSession('phone-sign-in',{idToken:await credential.user.getIdToken(),name:name.trim()});}
     finally{await signOut(getAuth(firebaseApp));}
   }catch(err){failure(err);}
   finally{setPending(false);}
 }
 return <form onSubmit={submit} aria-busy={pending}>
   <div className="form-group"><label htmlFor="otp-name">Your name</label><input id="otp-name" autoComplete="name" maxLength={100} required value={name} onChange={e=>setName(e.target.value)} disabled={pending}/></div>
   <div className="form-group"><label htmlFor="otp-phone">Mobile number</label><input id="otp-phone" type="tel" autoComplete="tel" placeholder="+91 98765 43210" maxLength={25} required value={phone} onChange={e=>setPhone(e.target.value)} disabled={pending||!!confirmation}/></div>
   {confirmation&&<><p role="status" className="auth-message">We sent a code to {phone}.</p><div className="form-group"><label htmlFor="otp-code">6-digit SMS code</label><input id="otp-code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={code} onChange={e=>setCode(e.target.value.replace(/\D/g,''))} disabled={pending}/></div></>}
   {error&&<p role="alert" className="auth-message">{error}</p>}
   <p className="auth-message">By continuing, you agree to receive a verification SMS. Google processes your phone number for authentication and abuse prevention. SMS rates may apply.</p>
   <div ref={captcha}/>
   <div className="submit-wrap"><button className="btn-base" type="submit" disabled={pending||(!confirmation&&cooldown>0)}>{pending?'Please wait…':confirmation?'Verify & sign in':cooldown?'Send again in '+cooldown+'s':'Send OTP'}</button></div>
   {confirmation&&<div style={{display:'flex',gap:20,justifyContent:'center',marginTop:20,fontSize:12}}>
     <button type="button" disabled={pending||cooldown>0} onClick={sendCode}>{cooldown?'Resend in '+cooldown+'s':'Resend code'}</button>
     <button type="button" disabled={pending} onClick={()=>{setConfirmation(null);setCode('');setError('');}}>Change number</button>
   </div>}
 </form>;
}
