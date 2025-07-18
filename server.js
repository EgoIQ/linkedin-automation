require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const axios = require('axios');
const winston = require('winston');

const app = express();
app.set('trust proxy', 1); // For Railway
const PORT = process.env.PORT || 3000;

// Configure Winston logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: 'automation.log' })
  ]
});

// Security middleware
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP'
});
app.use('/api/', limiter);

// Content generation prompts by funnel type
const CONTENT_PROMPTS = {
  TOF: {
    wordCount: '1200-1500',
    linkedinCount: '150-200',
    tone: 'Light, relatable, conversational with humor',
    goal: 'Maximum engagement and dwell time',
    structure: 'Hook → Problem → Stories → Insights → CTA'
  },
  MOF: {
    wordCount: '1500-2000',
    linkedinCount: '250-350',
    tone: 'Professional but approachable, authoritative',
    goal: 'Establish expertise and attract peer connections',
    structure: 'Context → Analysis → Framework → Implementation → CTA'
  },
  EOF: {
    wordCount: '2000-2500',
    linkedinCount: '300-400',
    tone: 'Professional, results-focused, credible',
    goal: 'Generate leads and consultation requests',
    structure: 'Challenge → Approach → Implementation → Results → CTA'
  }
};

// Function to split content at approximately 250 words
function splitContent(content, targetWords = 250) {
  const words = content.split(/\s+/);
  
  if (words.length <= targetWords) {
    return {
      firstPart: content,
      secondPart: ''
    };
  }
  
  const targetIndex = targetWords;
  let breakPoint = targetIndex;
  
  // Look for paragraph break (double newline) within ±50 words of target
  for (let i = Math.max(0, targetIndex - 50); i < Math.min(words.length, targetIndex + 50); i++) {
    const wordContext = words.slice(Math.max(0, i-2), i+3).join(' ');
    if (wordContext.includes('\n\n')) {
      breakPoint = i;
      break;
    }
  }
  
  // If no paragraph break found, look for sentence ending
  if (breakPoint === targetIndex) {
    for (let i = Math.max(0, targetIndex - 30); i < Math.min(words.length, targetIndex + 30); i++) {
      if (words[i] && (words[i].endsWith('.') || words[i].endsWith('!') || words[i].endsWith('?'))) {
        breakPoint = i + 1;
        break;
      }
    }
  }
  
  const firstPart = words.slice(0, breakPoint).join(' ');
  const secondPart = words.slice(breakPoint).join(' ');
  
  return {
    firstPart: firstPart.trim(),
    secondPart: secondPart.trim()
  };
}

// Function to safely parse Claude JSON response
function parseClaudeResponse(rawContent) {
  // Remove markdown code blocks if present
  let content = rawContent.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  
  // First attempt: direct parsing
  try {
    return JSON.parse(content);
  } catch (parseError) {
    logger.warn('Direct JSON parse failed, attempting to fix common issues:', parseError.message);
    
    // Second attempt: find JSON object boundaries
    const jsonStart = content.indexOf('{');
    const jsonEnd = content.lastIndexOf('}') + 1;
    
    if (jsonStart !== -1 && jsonEnd > jsonStart) {
      const jsonOnly = content.substring(jsonStart, jsonEnd);
      
      try {
        return JSON.parse(jsonOnly);
      } catch (secondParseError) {
        logger.warn('Bounded JSON parse failed, attempting content cleanup:', secondParseError.message);
        
        // Third attempt: fix common JSON issues in extracted content
        let cleanedJson = jsonOnly
          // Fix unescaped quotes in strings (basic attempt)
          .replace(/([^\\])"/g, '$1\\"')
          // Fix newlines in strings
          .replace(/\n/g, '\\n')
          .replace(/\r/g, '\\r')
          .replace(/\t/g, '\\t');
        
        try {
          return JSON.parse(cleanedJson);
        } catch (finalParseError) {
          logger.error('All JSON parsing attempts failed. Raw content sample:', {
            firstChars: content.substring(0, 200),
            lastChars: content.substring(Math.max(0, content.length - 200)),
            parseErrors: [parseError.message, secondParseError.message, finalParseError.message]
          });
          throw new Error(`Unable to parse Claude response after multiple attempts: ${finalParseError.message}`);
        }
      }
    } else {
      logger.error('No valid JSON object boundaries found in Claude response');
      throw new Error(`No valid JSON found in Claude response: ${parseError.message}`);
    }
  }
}

// Function to generate content using Claude API
async function generateContent(headline, summary, category, funnelType, author) {
  const prompt = `You are a professional content creator specializing in LinkedIn content for SME leaders and B2C companies under 200 employees.

CONTENT REQUIREMENTS:
- Funnel Type: ${funnelType}
- Word Count: ${CONTENT_PROMPTS[funnelType].wordCount} words
- LinkedIn Snippet: ${CONTENT_PROMPTS[funnelType].linkedinCount} words
- Tone: ${CONTENT_PROMPTS[funnelType].tone}
- Goal: ${CONTENT_PROMPTS[funnelType].goal}
- Structure: ${CONTENT_PROMPTS[funnelType].structure}

CONTENT DETAILS:
- Headline: ${headline}
- Summary: ${summary}
- Category: ${category}
- Author: ${author}

TARGET AUDIENCE: SME Leaders & Founders in Travel, Wellness/Fitness, Retail, Food & Beverages, Hospitality

FORMATTING REQUIREMENTS:
- Use ONLY Markdown formatting (NO HTML tags)
- NO emoticons or emojis anywhere in the content
- Use ## for main headings, ### for subheadings
- Use * or - for bullet points
- Use **bold** and *italic* for emphasis
- Add line breaks logically to ensure readability
- Use > for blockquotes if needed
- Clean, professional formatting only

INSTRUCTIONS:
1. Create a comprehensive blog article based on the headline and summary
2. Use the specified funnel type approach and structure
3. Include actionable insights and real-world examples
4. End with a clear call-to-action
5. Create a separate LinkedIn snippet that teases the full article
6. Write in Markdown format only - no HTML, no emoticons
7. Make the content substantial enough to be split into two parts

RESPONSE FORMAT:
Return your response as a JSON object with exactly these fields:
{
  "articleBody": "Full article content in Markdown format (no HTML, no emoticons)",
  "linkedinSnippet": "LinkedIn post content with hook and CTA to read full article (no emoticons)"
}

Your entire response must be valid JSON. Do not include any text outside the JSON structure.`;

  try {
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        messages: [
          {
            role: 'user',
            content: prompt
          }
        ]
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.CLAUDE_API_KEY,
          'anthropic-version': '2023-06-01'
        }
      }
    );

    // Use the improved parsing function
    const rawContent = response.data.content[0].text;
    return parseClaudeResponse(rawContent);

  } catch (error) {
    logger.error('Claude API Error:', {
      status: error.response?.status,
      statusText: error.response?.statusText,
      data: error.response?.data,
      message: error.message
    });
    throw new Error(`Claude API failed: ${error.response?.status || error.message}`);
  }
}

// Function to create article in Strapi
async function createStrapiArticle(headline, summary, articleBody, bodyImageText, category, author) {
  try {
    const strapiData = {
      data: {
        title: headline,
        headline: headline,
        summary: summary,
        body: articleBody,
        bodyImageText: bodyImageText,
        publishDate: new Date().toISOString(),
        publishedAt: null // Keep as draft
      }
    };

    const response = await axios.post(
      `${process.env.STRAPI_URL}/api/articles`,
      strapiData,
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.CONTENT_AUTOMATION_KEY}`
        }
      }
    );

    return response.data.data.id;
  } catch (error) {
    logger.error('Error creating Strapi article:', error);
    throw error;
  }
}

// API Routes
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    endpoints: {
      generate: '/api/generate',
      webhook: '/webhook',
      testWebhook: '/test-webhook',
      health: '/api/health'
    }
  });
});

app.get('/api/debug-claude', async (req, res) => {
  try {
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514',
        max_tokens: 100,
        messages: [
          {
            role: 'user',
            content: 'Hello, respond with JSON: {"test": "success"}'
          }
        ]
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.CLAUDE_API_KEY,
          'anthropic-version': '2023-06-01'
        }
      }
    );

    res.json({
      success: true,
      claude_response: response.data
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      details: error.response?.data
    });
  }
});

app.get('/api/debug-strapi', async (req, res) => {
  try {
    const testArticle = {
      data: {
        title: "Test Article",
        headline: "Test Article",
        summary: "This is a test article",
        body: "## Test Content\n\nThis is the first part of the test content.",
        bodyImageText: "This is the second part of the test content that goes into bodyImageText.",
        publishDate: new Date().toISOString(),
        publishedAt: null
      }
    };

    const response = await axios.post(
      `${process.env.STRAPI_URL}/api/articles`,
      testArticle,
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.CONTENT_AUTOMATION_KEY}`
        }
      }
    );

    res.json({
      success: true,
      strapi_response: response.data
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      details: error.response?.data,
      status: error.response?.status
    });
  }
});

// Main generation endpoint
app.post('/api/generate', async (req, res) => {
  try {
    const { headline, summary, category, funnelType, author } = req.body;
    
    if (!headline || !summary || !category || !funnelType || !author) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required fields: headline, summary, category, funnelType, author' 
      });
    }

    logger.info(`Processing generation request: ${headline}`);
    
    const generatedContent = await generateContent(headline, summary, category, funnelType, author);
    const { firstPart, secondPart } = splitContent(generatedContent.articleBody, 250);
    
    logger.info(`Content split: First part: ${firstPart.split(/\s+/).length} words, Second part: ${secondPart.split(/\s+/).length} words`);
    
    const strapiArticleId = await createStrapiArticle(
      headline,
      summary,
      firstPart,
      secondPart,
      category,
      author
    );
    
    logger.info(`Successfully generated article ${strapiArticleId} for: ${headline}`);
    
    res.json({
      success: true,
      data: {
        strapiId: strapiArticleId.toString(),
        linkedinSnippet: generatedContent.linkedinSnippet,
        generatedDate: new Date().toISOString().split('T')[0],
        bodyWordCount: firstPart.split(/\s+/).length,
        bodyImageTextWordCount: secondPart.split(/\s+/).length
      }
    });
    
  } catch (error) {
    logger.error('Generation error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// Webhook endpoint (for n8n integration)
app.post('/webhook', async (req, res) => {
  try {
    logger.info('Webhook received:', req.body);
    
    const { headline, summary, category, funnelType, author } = req.body;
    
    if (!headline || !summary || !category || !funnelType) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required fields',
        status: 'error'
      });
    }

    logger.info(`Processing webhook request: ${headline}`);
    
    const generatedContent = await generateContent(headline, summary, category, funnelType, author || 'EgoIQ Team');
    const { firstPart, secondPart } = splitContent(generatedContent.articleBody, 250);
    
    const strapiArticleId = await createStrapiArticle(
      headline,
      summary,
      firstPart,
      secondPart,
      category,
      author || 'EgoIQ Team'
    );
    
    logger.info(`Successfully generated article ${strapiArticleId}`);
    
    res.json({
      success: true,
      data: {
        strapiId: strapiArticleId.toString(),
        linkedinSnippet: generatedContent.linkedinSnippet,
        generatedDate: new Date().toISOString().split('T')[0],
        bodyWordCount: firstPart.split(/\s+/).length,
        bodyImageTextWordCount: secondPart.split(/\s+/).length,
        status: 'generated',
        notes: `Generated ${funnelType} content successfully`
      }
    });
    
  } catch (error) {
    logger.error('Webhook error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      status: 'error',
      notes: `Generation failed: ${error.message}`
    });
  }
});

// Test webhook endpoint
app.post('/test-webhook', async (req, res) => {
  try {
    const testData = {
      headline: "Test Article - Clean Webhook System",
      summary: "Testing the cleaned webhook system for LinkedIn automation",
      category: "Test",
      funnelType: "TOF",
      author: "Test Author"
    };

    logger.info('Testing webhook with data:', testData);

    // Call our own webhook endpoint
    const response = await axios.post(`http://localhost:${PORT}/webhook`, testData, {
      headers: { 'Content-Type': 'application/json' }
    });

    res.json({
      success: true,
      message: 'Test webhook executed successfully',
      result: response.data
    });

  } catch (error) {
    logger.error('Test webhook error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Start server
app.listen(PORT, () => {
  logger.info(`🚀 LinkedIn Automation Service running on port ${PORT}`);
  logger.info(`📍 Health check: http://localhost:${PORT}/api/health`);
  logger.info('Ready to receive generation requests');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');
  process.exit(0);
});