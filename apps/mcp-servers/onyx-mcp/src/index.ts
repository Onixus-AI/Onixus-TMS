
import express from 'express';
const app = express(); app.use(express.json());
const tools = [
  { name: 'ingest_document', description: 'Ingest BOL, rate sheet, contract -> embeddings' },
  { name: 'query_knowledge_base', description: 'Semantic search over docs via LanceDB + Ollama' },
  { name: 'extract_container_details_from_bol', description: 'OCR BOL to extract container, seal, etc' },
  { name: 'summarize_rate_tariff', description: 'Summarize rate tariff PDF' }
];
app.get('/tools', (req,res)=> res.json({tools}));
app.post('/tools/:toolName', async (req,res)=>{
  // Ollama: nomic-embed-text for embeddings, moondream for vision, llama3.2 for summary
  // LanceDB for vector search
  res.json({success:true, tool:req.params.toolName});
});
app.listen(4003, ()=> console.log('ONYX MCP on 4003'));
