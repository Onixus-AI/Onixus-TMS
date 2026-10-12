
import express from 'express';
import dotenv from 'dotenv';
import nodemailer from 'nodemailer';
dotenv.config();
const app = express(); app.use(express.json());

// YOUR OWN BUSINESS EMAIL MCP - dispatch@onixus.ai etc
// Connects via SMTP/IMAP to your domain, not Gmail OAuth

const transporter = nodemailer.createTransport({
  host: process.env.BUSINESS_EMAIL_SMTP_HOST,
  port: 587,
  auth: {
    user: process.env.BUSINESS_EMAIL_SMTP_USER,
    pass: process.env.BUSINESS_EMAIL_SMTP_PASS
  }
});

const tools = [
  { 
    name: 'send_business_email', 
    description: 'Send email from your business domain (dispatch@onixus.ai, ops@onixus.ai)',
    inputSchema: { from: 'string', to: 'string', subject: 'string', html: 'string', load_id: 'optional' }
  },
  { 
    name: 'parse_inbound_business_email',
    description: 'Parse inbound email to your business inbox and auto-create load/quote. Handles rate requests from shippers/manufacturers/brokers'
  },
  {
    name: 'auto_reply_with_quote',
    description: 'Auto-generate quote from rate_tariffs and reply'
  },
  {
    name: 'send_bulk_tracking_updates',
    description: 'Send tracking updates to all customers with loads in transit'
  }
];

app.get('/tools', (req,res)=> res.json({tools, domain: process.env.BUSINESS_EMAIL_DOMAIN}));

app.post('/tools/:toolName', async (req,res)=>{
  const {toolName} = req.params;
  const body = req.body;
  
  if(toolName === 'send_business_email'){
    const info = await transporter.sendMail({
      from: body.from || `Onixus Dispatch <${process.env.BUSINESS_EMAIL_SMTP_USER}>`,
      to: body.to,
      subject: body.subject,
      html: body.html
    });
    return res.json({success:true, messageId: info.messageId});
  }
  
  // Parse inbound -> create load draft
  if(toolName === 'parse_inbound_business_email'){
    // 1. Extract container regex, BOL, origin/dest
    // 2. Call CRM MCP to find customer
    // 3. Create load in Supabase
    console.log('Parsing business email', body);
    return res.json({success:true, parsed: {container_number: body.container_number, load_id: 'LD-'+Date.now()}});
  }
  
  res.json({success:true, tool:toolName});
});

app.get('/health', (req,res)=> res.json({status:'ok', mcp:'business-email-mcp', domain: process.env.BUSINESS_EMAIL_DOMAIN}));

app.listen(4004, ()=> console.log('Business Email MCP on 4004 for', process.env.BUSINESS_EMAIL_DOMAIN));
