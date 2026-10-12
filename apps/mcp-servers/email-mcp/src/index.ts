
import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import dotenv from 'dotenv';
dotenv.config();
const app = express(); app.use(express.json());

// MCP Tools for Email
const tools = [
  { name: 'list_unread_drayage_emails', description: 'List unread emails containing BOL, POD, rate requests' },
  { name: 'parse_email_to_load_draft', description: 'Parse email body to create DRAFT load with container, booking, etc' },
  { name: 'send_tracking_update', description: 'Send tracking update email to customer' },
  { name: 'send_pod_email', description: 'Send POD + invoice to shipper/broker' },
  { name: 'extract_container_number', description: 'Regex extract container numbers from email/docs: 4 letters + 7 digits' }
];

app.get('/tools', (req,res)=> res.json({tools}));
app.post('/tools/:toolName', async (req,res)=>{
  const {toolName} = req.params;
  // Implement Gmail API logic here
  // Gmail: googleapis, Outlook: @microsoft/microsoft-graph-client
  console.log(`Executing ${toolName}`, req.body);
  res.json({success:true, tool:toolName, result: {load_number: 'LD-'+Date.now()}});
});

app.listen(4001, ()=> console.log('Email MCP on 4001'));
