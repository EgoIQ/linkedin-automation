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

// Simplified function to split content by subheadings (first 2 vs remaining 4)
function splitContentBySubheadings(content, subheadings) {
  const validSubheadings = subheadings.filter(sh => sh && sh.trim());
  
  // We should always have at least 4 subheadings due to validation
  const thirdSubheading = validSubheadings[2];
  
  // Look for the third subheading to split after the second
  const splitPattern = new RegExp(`(## ${thirdSubheading})`, 'i');
  const splitMatch = content.search(splitPattern);
  
  if (splitMatch !== -1) {
    return {
      firstPart: content.substring(0, splitMatch),
      secondPart: content.substring(splitMatch)
    };
  }
  
  // If subheading matching fails, split roughly in half as emergency fallback
  const halfPoint = Math.floor(content.length / 2);
  return {
    firstPart: content.substring(0, halfPoint),
    secondPart: content.substring(halfPoint)
  };
}

// Function to safely parse Claude JSON response while preserving line breaks
function parseClaudeResponse(rawContent) {
  // Remove markdown code blocks if present
  let content = rawContent.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  
  // First attempt: direct parsing
  try {
    return JSON.parse(content);
  } catch (parseError) {
    logger.warn('Direct JSON parse failed, attempting to fix while preserving formatting:', parseError.message);
    
    // Second attempt: find JSON object boundaries
    const jsonStart = content.indexOf('{');
    const jsonEnd = content.lastIndexOf('}') + 1;
    
    if (jsonStart !== -1 && jsonEnd > jsonStart) {
      let jsonOnly = content.substring(jsonStart, jsonEnd);
      
      try {
        return JSON.parse(jsonOnly);
      } catch (secondParseError) {
        logger.warn('Bounded JSON parse failed, attempting content extraction and re-construction:', secondParseError.message);
        
        // Third attempt: Extract content and rebuild JSON properly
        try {
          // Extract the raw content between quotes, being careful with nested quotes
          const articleBodyStart = jsonOnly.indexOf('"articleBody": "') + '"articleBody": "'.length;
          const linkedinStart = jsonOnly.indexOf('"linkedinSnippet": "') + '"linkedinSnippet": "'.length;
          
          // Find the end of articleBody (look for the quote before linkedinSnippet)
          const articleBodyEnd = jsonOnly.lastIndexOf('",', linkedinStart - '"linkedinSnippet": "'.length);
          
          // Find the end of linkedinSnippet (look for quote before closing brace)
          const linkedinEnd = jsonOnly.lastIndexOf('"', jsonOnly.length - 2);
          
          if (articleBodyStart > 0 && articleBodyEnd > articleBodyStart && linkedinStart > 0 && linkedinEnd > linkedinStart) {
            // Extract raw content
            const rawArticleBody = jsonOnly.substring(articleBodyStart, articleBodyEnd);
            const rawLinkedinSnippet = jsonOnly.substring(linkedinStart, linkedinEnd);
            
            // Create properly formatted JSON object
            const reconstructedJson = {
              articleBody: rawArticleBody,
              linkedinSnippet: rawLinkedinSnippet
            };
            
            logger.info('Successfully reconstructed JSON while preserving formatting');
            return reconstructedJson;
          }
        } catch (reconstructError) {
          logger.warn('JSON reconstruction failed:', reconstructError.message);
        }
        
        // Fourth attempt: try to fix JSON structure while preserving newlines
        try {
          // Look for the pattern and extract content more carefully
          const articleMatch = jsonOnly.match(/"articleBody":\s*"([\s\S]*?)",\s*"linkedinSnippet":\s*"([\s\S]*?)"\s*}/);
          
          if (articleMatch) {
            return {
              articleBody: articleMatch[1],
              linkedinSnippet: articleMatch[2]
            };
          }
        } catch (regexError) {
          logger.warn('Regex extraction failed:', regexError.message);
        }
        
        logger.error('All JSON parsing attempts failed. Raw content sample:', {
          firstChars: content.substring(0, 500),
          lastChars: content.substring(Math.max(0, content.length - 500)),
          contentLength: content.length,
          parseErrors: [parseError.message, secondParseError.message]
        });
        throw new Error(`Unable to parse Claude response after multiple attempts: ${secondParseError.message}`);
      }
    } else {
      logger.error('No valid JSON object boundaries found in Claude response');
      throw new Error(`No valid JSON found in Claude response: ${parseError.message}`);
    }
  }
}

// Parse categories from Google Sheets input
function parseCategories(categoryInput) {
  if (!categoryInput) return [];
  
  if (Array.isArray(categoryInput)) {
    return categoryInput;
  }
  
  // Handle comma-separated string
  return categoryInput.split(',').map(cat => cat.trim()).filter(cat => cat.length > 0);
}

// Fetch existing categories from Strapi
async function getStrapiCategories() {
  try {
    const response = await axios.get(`${process.env.STRAPI_URL}/api/categories?pagination[limit]=100`, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.CONTENT_AUTOMATION_KEY}`
      }
    });
    
    return response.data.data || [];
  } catch (error) {
    logger.error('Error fetching Strapi categories:', error.response?.data || error.message);
    return [];
  }
}

// Find category IDs by names
async function findCategoryIds(categoryNames) {
  const strapiCategories = await getStrapiCategories();
  const categoryIds = [];
  
  for (const categoryName of categoryNames) {
    const foundCategory = strapiCategories.find(cat => 
      cat.attributes.name.toLowerCase() === categoryName.toLowerCase()
    );
    
    if (foundCategory) {
      categoryIds.push(foundCategory.id);
    } else {
      logger.warn(`Category not found in Strapi: ${categoryName}`);
    }
  }
  
  return categoryIds;
}

// Enhanced function to generate content using Claude API with subheading guidance
async function generateContent(headline, summary, categories, funnelType, subheadings = []) {
  const categoryText = Array.isArray(categories) ? categories.join(', ') : categories;
  const validSubheadings = subheadings.filter(sh => sh && sh.trim());
  
  // Create subheading guidance for Claude
  let subheadingGuidance = '';
  if (validSubheadings.length >= 4) {
    subheadingGuidance = `
STRUCTURE REQUIREMENTS - USE THESE SPECIFIC SUBHEADINGS:
Please structure your article using these exact subheadings in order:
1. ## ${validSubheadings[0]}
2. ## ${validSubheadings[1]}
3. ## ${validSubheadings[2]}
4. ## ${validSubheadings[3]}`;

    if (validSubheadings[4]) subheadingGuidance += `\n5. ## ${validSubheadings[4]}`;
    if (validSubheadings[5]) subheadingGuidance += `\n6. ## ${validSubheadings[5]}`;
    
    subheadingGuidance += '\n\nWrite comprehensive content under each subheading that flows naturally and provides substantial value.';
  }

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
- Categories: ${categoryText}

${subheadingGuidance}

TARGET AUDIENCE: SME Leaders & Founders in Travel, Wellness/Fitness, Retail, Food & Beverages, Hospitality

FORMATTING REQUIREMENTS - CRITICAL FOR PROPER DISPLAY:
- Use ONLY Markdown formatting (NO HTML tags)
- NO emoticons or emojis anywhere in the content
- Use ## for main headings, ### for subheadings
- Use * or - for bullet points
- Use **bold** and *italic* for emphasis
- CRITICAL: Add EXACTLY TWO newlines (\\n\\n) between ALL paragraphs for proper spacing
- CRITICAL: Add EXACTLY TWO newlines (\\n\\n) after headings before the next paragraph
- Use > for blockquotes if needed
- Clean, professional formatting only
- Ensure each paragraph is separated by blank lines
- This formatting is ESSENTIAL for proper display in the content management system

INSTRUCTIONS:
1. Create a comprehensive blog article based on the headline and summary
2. Use the specified funnel type approach and structure
3. Follow the provided subheading structure exactly
4. Include actionable insights and real-world examples
5. End with a clear call-to-action
6. Create a separate LinkedIn snippet that teases the full article
7. Write in Markdown format only - no HTML, no emoticons
8. Make the content substantial and well-structured
9. ENSURE proper paragraph spacing with double newlines

RESPONSE FORMAT:
Return your response as a JSON object with exactly these fields:
{
  "articleBody": "Full article content in Markdown format with proper \\n\\n spacing",
  "linkedinSnippet": "LinkedIn post content with hook and CTA to read full article"
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

// Enhanced function to create article in Strapi with categories and LinkedIn summary
async function createStrapiArticle(headline, summary, articleBody, bodyImageText, categoryIds, linkedinSnippet) {
  try {
    const strapiData = {
      data: {
        title: headline,
        headline: headline,
        summary: summary,
        body: articleBody,
        bodyImageText: bodyImageText,
        linkedInSummary: linkedinSnippet,
        categories: categoryIds,
        publishDate: new Date().toISOString(),
        publishedAt: null // Keep as draft for human editor
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
    logger.error('Error creating Strapi article:', error.response?.data || error.message);
    throw error;
  }
}

// API Routes
app.get('/api/health', async (req, res) => {
  try {
    // Test Strapi connection and categories
    const strapiCategories = await getStrapiCategories();
    
    res.json({ 
      status: 'healthy', 
      timestamp: new Date().toISOString(),
      version: '2.0.0',
      strapi_connection: {
        categories_available: strapiCategories.length,
        sample_categories: strapiCategories.slice(0, 5).map(cat => cat.attributes?.name || 'Unknown')
      },
      endpoints: {
        generate: '/api/generate',
        webhook: '/webhook',
        testWebhook: '/test-webhook',
        health: '/api/health'
      }
    });
  } catch (error) {
    res.status(500).json({
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
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
        body: "## Test Content\n\nThis is the first part of the test content.\n\nAnother paragraph with proper spacing.",
        bodyImageText: "## More Content\n\nThis is the second part of the test content.\n\nWith proper paragraph spacing.",
        linkedInSummary: "Test LinkedIn summary for this article with proper formatting.",
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

// Enhanced main generation endpoint
app.post('/api/generate', async (req, res) => {
  try {
    const { headline, summary, category, funnelType, subheading1, subheading2, subheading3, subheading4, subheading5, subheading6 } = req.body;
    
    if (!headline || !summary || !category || !funnelType) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required fields: headline, summary, category, funnelType' 
      });
    }

    // Parse categories and get IDs
    const categories = parseCategories(category);
    const categoryIds = await findCategoryIds(categories);
    
    if (categoryIds.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: `No matching categories found in Strapi for: ${categories.join(', ')}` 
      });
    }

    const subheadings = [subheading1, subheading2, subheading3, subheading4, subheading5, subheading6];
    const validSubheadings = subheadings.filter(sh => sh && sh.trim());
    
    if (validSubheadings.length < 4) {
      return res.status(400).json({ 
        success: false, 
        error: 'At least 4 subheadings are required (subheading1-4 minimum)' 
      });
    }
    
    logger.info(`Processing generation request: ${headline} with ${validSubheadings.length} subheadings`);
    
    const generatedContent = await generateContent(headline, summary, categories, funnelType, subheadings);
    const { firstPart, secondPart } = splitContentBySubheadings(generatedContent.articleBody, subheadings);
    
    logger.info(`Content split: First part: ${firstPart.split(/\s+/).length} words, Second part: ${secondPart.split(/\s+/).length} words`);
    
    const strapiArticleId = await createStrapiArticle(
      headline,
      summary,
      firstPart,
      secondPart,
      categoryIds,
      generatedContent.linkedinSnippet
    );
    
    logger.info(`Successfully generated article ${strapiArticleId} for: ${headline}`);
    
    res.json({
      success: true,
      data: {
        strapiId: strapiArticleId.toString(),
        linkedinSnippet: generatedContent.linkedinSnippet,
        generatedDate: new Date().toISOString().split('T')[0],
        bodyWordCount: firstPart.split(/\s+/).length,
        bodyImageTextWordCount: secondPart.split(/\s+/).length,
        categoriesConnected: categoryIds.length,
        subheadingsUsed: validSubheadings.length
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

// Enhanced webhook endpoint (for n8n integration)
app.post('/webhook', async (req, res) => {
  try {
    logger.info('Webhook received:', req.body);
    
    const { headline, summary, category, funnelType, subheading1, subheading2, subheading3, subheading4, subheading5, subheading6 } = req.body;
    
    if (!headline || !summary || !category || !funnelType) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required fields: headline, summary, category, funnelType',
        status: 'error'
      });
    }

    // Parse categories and get IDs
    const categories = parseCategories(category);
    const categoryIds = await findCategoryIds(categories);
    
    if (categoryIds.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: `No matching categories found in Strapi for: ${categories.join(', ')}`,
        status: 'error'
      });
    }

    const subheadings = [subheading1, subheading2, subheading3, subheading4, subheading5, subheading6];
    const validSubheadings = subheadings.filter(sh => sh && sh.trim());
    
    if (validSubheadings.length < 4) {
      return res.status(400).json({ 
        success: false, 
        error: 'At least 4 subheadings are required (subheading1-4 minimum)',
        status: 'error'
      });
    }
    
    logger.info(`Processing webhook request: ${headline} with ${validSubheadings.length} subheadings, categories: ${categories.join(', ')}`);
    
    const generatedContent = await generateContent(headline, summary, categories, funnelType, subheadings);
    const { firstPart, secondPart } = splitContentBySubheadings(generatedContent.articleBody, subheadings);
    
    const strapiArticleId = await createStrapiArticle(
      headline,
      summary,
      firstPart,
      secondPart,
      categoryIds,
      generatedContent.linkedinSnippet
    );
    
    logger.info(`Successfully generated article ${strapiArticleId}`);
    
    res.json({
      success: true,
      articleId: strapiArticleId,
      data: {
        strapiId: strapiArticleId.toString(),
        linkedinSnippet: generatedContent.linkedinSnippet,
        generatedDate: new Date().toISOString().split('T')[0],
        bodyWordCount: firstPart.split(/\s+/).length,
        bodyImageTextWordCount: secondPart.split(/\s+/).length,
        status: 'generated',
        notes: `Generated ${funnelType} content successfully`,
        categoriesConnected: categoryIds.length,
        subheadingsUsed: validSubheadings.length,
        categories: categories
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

// Enhanced test webhook endpoint
app.post('/test-webhook', async (req, res) => {
  try {
    const testData = {
      headline: "The Future of AI-Powered Content Marketing",
      summary: "Explore how artificial intelligence is revolutionizing content marketing strategies and what businesses need to know to stay competitive.",
      category: "Marketing, Technology",
      funnelType: "MOF",
      subheading1: "Understanding AI in Content Marketing",
      subheading2: "Current AI Tools and Technologies",
      subheading3: "Implementation Strategies for Businesses",
      subheading4: "Measuring ROI and Success Metrics",
      subheading5: "Common Challenges and Solutions",
      subheading6: "Future Trends and Predictions"
    };

    logger.info('Testing webhook with enhanced data:', testData);

    // Call our own webhook endpoint
    const response = await axios.post(`http://localhost:${PORT}/webhook`, testData, {
      headers: { 'Content-Type': 'application/json' }
    });

    res.json({
      success: true,
      message: 'Test webhook executed successfully with subheadings and categories',
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
  logger.info('✨ Enhanced with subheading-guided content generation');
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