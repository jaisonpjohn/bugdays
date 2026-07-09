/**
 * Contact Form & Feedback Worker
 * Handles POST requests from contact form and tool feedback, stores in D1
 */

export interface Env {
  DB: D1Database;
}

interface ContactSubmission {
  name: string;
  email: string;
  message: string;
  type?: 'contact' | 'bug' | 'feature' | 'feedback';
  tool?: string;
}

// Validate email format
function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

// Sanitize input to prevent basic injection
function sanitize(input: string): string {
  return input.trim().slice(0, 5000); // Limit length
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // CORS headers - allow bugdays.com and localhost for dev
    const origin = request.headers.get('Origin') || '';
    const allowedOrigins = ['https://bugdays.com', 'https://www.bugdays.com', 'http://localhost:4321'];
    const corsOrigin = allowedOrigins.includes(origin) ? origin : 'https://bugdays.com';

    const corsHeaders = {
      'Access-Control-Allow-Origin': corsOrigin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    // Handle preflight requests
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Only allow POST
    if (request.method !== 'POST') {
      return new Response(
        JSON.stringify({ success: false, error: 'Method not allowed' }),
        {
          status: 405,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

    try {
      const body = await request.json() as ContactSubmission;
      const submissionType = body.type || 'contact';
      const isFeedback = ['bug', 'feature', 'feedback'].includes(submissionType);

      // Validate required fields
      if (!body.message) {
        return new Response(
          JSON.stringify({ success: false, error: 'Message is required' }),
          {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          }
        );
      }

      // For contact form, name and email are required
      // For feedback, they're optional
      if (!isFeedback && (!body.name || !body.email)) {
        return new Response(
          JSON.stringify({ success: false, error: 'Name and email are required' }),
          {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          }
        );
      }

      // Validate email format if provided
      if (body.email && !isValidEmail(body.email)) {
        return new Response(
          JSON.stringify({ success: false, error: 'Invalid email format' }),
          {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          }
        );
      }

      // Sanitize inputs
      const name = sanitize(body.name || 'Anonymous');
      const email = sanitize(body.email || '');
      const message = sanitize(body.message);
      const tool = body.tool ? sanitize(body.tool) : null;

      // Validate message length
      if (message.length < 10) {
        return new Response(
          JSON.stringify({ success: false, error: 'Message is too short (minimum 10 characters)' }),
          {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          }
        );
      }

      // Insert into D1 database
      await env.DB.prepare(
        'INSERT INTO contacts (name, email, message, type, tool) VALUES (?, ?, ?, ?, ?)'
      )
        .bind(name, email, message, submissionType, tool)
        .run();

      const successMessages: Record<string, string> = {
        contact: 'Message received! We\'ll get back to you soon.',
        bug: 'Bug report submitted. Thanks for helping us improve!',
        feature: 'Feature request received. Thanks for the suggestion!',
        feedback: 'Feedback received. Thank you!',
      };

      return new Response(
        JSON.stringify({ success: true, message: successMessages[submissionType] || 'Received' }),
        {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    } catch (error) {
      console.error('Submission error:', error);

      return new Response(
        JSON.stringify({ success: false, error: 'Internal server error' }),
        {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }
  },
};
