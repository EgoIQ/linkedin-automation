require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const axios = require('axios');
const winston = require('winston');

const app = express();
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
    wordCount: '800-1200',
    linkedinCount: '150-200',
    tone: 'Light, relatable, conversational with humor',
    goal: 'Maximum engagement and dwell time',
    structure: 'Hook → Problem → Stories → Insights → CTA'
  },
  MOF: {
    wordCount: '1200-1800',
    linkedinCount: '250-350',
    tone: 'Professional but approachable, authoritative',
    goal: 'Establish expertise and attract peer connections',
    structure: 'Context → Analysis → Framework → Implementation → CTA'
  },
  EOF: {
    wordCount: '1500-2000',
    linkedinCount: '300-400',
    tone: 'Professional, results-focused, credible',
    goal: 'Generate leads and consultation requests',
    structure: 'Challenge → Approach → Implementation → Results → CTA'
  }
};

// Updated Claude API function for server.js
// Replace the existing generateContent function with this:

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

INSTRUCTIONS:
1. Create a comprehensive blog article based on the headline and summary
2. Use the specified funnel type approach and structure
3. Include actionable insights and real-world examples
4. End with a clear call-to-action
5. Create a separate LinkedIn snippet that teases the full article

RESPONSE FORMAT:
Return your response as a JSON object with exactly these fields:
{
  "articleBody": "Full article content in HTML format",
  "linkedinSnippet": "LinkedIn post content with hook and CTA to read full article"
}

Your entire response must be valid JSON. Do not include any text outside the JSON structure.`;

  try {
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-20250514', // Updated model name
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
          'anthropic-version': '2024-08-01'
        }
      }
    );

    const content = response.data.content[0].text;
    return JSON.parse(content);
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
async function createStrapiArticle(headline, summary, articleBody, category, author) {
  try {
    const strapiData = {
      data: {
        title: headline,
        headline: headline,
        summary: summary,
        body: articleBody,
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
    version: '1.0.0'
  });
});

// Main webhook endpoint for Google Apps Script
app.post('/api/generate', async (req, res) => {
  try {
    const { headline, summary, category, funnelType, author } = req.body;
    
    // Validate required fields
    if (!headline || !summary || !category || !funnelType || !author) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required fields: headline, summary, category, funnelType, author' 
      });
    }

    logger.info(`Processing generation request: ${headline}`);
    
    // Generate content
    const generatedContent = await generateContent(headline, summary, category, funnelType, author);
    
    // Create Strapi article
    const strapiArticleId = await createStrapiArticle(
      headline,
      summary,
      generatedContent.articleBody,
      category,
      author
    );
    
    logger.info(`Successfully generated article ${strapiArticleId} for: ${headline}`);
    
    // Return results to Google Apps Script
    res.json({
      success: true,
      data: {
        strapiId: strapiArticleId.toString(),
        linkedinSnippet: generatedContent.linkedinSnippet,
        generatedDate: new Date().toISOString().split('T')[0]
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

// Start server
app.listen(PORT, () => {
  logger.info(`LinkedIn Automation Service running on port ${PORT}`);
  logger.info('Ready to receive generation requests from Google Apps Script');
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
