import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ShieldCheck, ArrowLeft } from 'lucide-react';
import { useAuth } from './components/auth-provider';
export default function StaffProfile(){
 const {user,changeSession}=useAuth();
 const [name,setName]=useState(user.name);
 const [busy,setBusy]=useState(false);
 const [message,setMessage]=useState('');
 return <main className="admin-content" style={{maxWidth:760,paddingTop:50}}>
  <Link to="/dashboard" className="admin-refresh" style={{width:'fit-content',marginBottom:24}}><ArrowLeft size={16}/>Back to pipeline</Link>
  <section className="admin-card" style={{padding:32}}>
   <p className="admin-kicker">PIPELINE / MY PROFILE</p><h1 style={{fontSize:30}}>Staff profile</h1>
   <p style={{display:'flex',gap:8,alignItems:'center',color:'#0f766e'}}><ShieldCheck size={18}/> Authorized administrator</p>
   <p>{user.email}</p>
   <p style={{color:'#64748b'}}>This account manages orders and the product catalog in the pipeline app.</p>
   <form onSubmit={async event=>{event.preventDefault();setBusy(true);setMessage('');try{await changeSession('update-profile',{name});setMessage('Profile updated.');}catch(e){setMessage(e.message);}finally{setBusy(false);}}} style={{display:'grid',gap:12,marginTop:24}}>
    <label htmlFor="staff-name">Display name</label><input id="staff-name" value={name} onChange={e=>setName(e.target.value)} required maxLength={100} style={{padding:12,border:'1px solid #cbd5e1',borderRadius:8}}/>
    <button className="admin-primary" disabled={busy} style={{border:0,cursor:'pointer',justifyContent:'center'}}>{busy?'Saving…':'Save staff profile'}</button>
    {message&&<p role="status">{message}</p>}
   </form>
  </section>
 </main>;
}
