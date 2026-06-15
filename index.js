#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import { z } from "zod";
import { google } from 'googleapis';
import { authenticate } from "@google-cloud/local-auth";
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const TOKEN_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "tokens.json"
);

const WORKSPACE_ROOT = "/workspace/user";

function isSafePath(filePath) {
  const resolvedPath = path.resolve(WORKSPACE_ROOT, filePath);
  return resolvedPath.startsWith(WORKSPACE_ROOT);
}

const server = new McpServer({
  name: "class",
  version: "1.0.0"
});

const CLIENT_CREDENTIALS_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "credentials.json"
);

async function loadClientCredentials() {
  try {
    const credentialsContent = await fs.readFile(CLIENT_CREDENTIALS_PATH, 'utf8');
    return JSON.parse(credentialsContent).web || JSON.parse(credentialsContent).installed;
  } catch (error) {
    throw new Error(`Failed to load client credentials: ${error.message}`);
  }
}

async function authenticateAndSaveCredentials() {
  const auth = await authenticate({
    keyfilePath: CLIENT_CREDENTIALS_PATH,
    scopes: [
      'https://www.googleapis.com/auth/classroom.courses.readonly',
      'https://www.googleapis.com/auth/classroom.announcements.readonly',
      'https://www.googleapis.com/auth/classroom.coursework.me.readonly',
      'https://www.googleapis.com/auth/classroom.rosters.readonly',
      'https://www.googleapis.com/auth/classroom.coursework.me',
      'https://www.googleapis.com/auth/classroom.courseworkmaterials.readonly'
    ],
  });
  
  await fs.writeFile(TOKEN_PATH, JSON.stringify(auth.credentials));
  return auth;
}

async function loadCredentials() {
  if (!await fs.access(TOKEN_PATH).then(() => true).catch(() => false)) {
    throw new Error('Credentials not found. Please run with "auth" argument first.');
  }
  let credentials;
  try {
    credentials = JSON.parse(await fs.readFile(TOKEN_PATH, 'utf-8'));
  } catch (error) {
    throw new Error('Failed to parse credentials: Invalid JSON in tokens.json');
  }
  
  const auth = new google.auth.OAuth2();
  auth.setCredentials(credentials);
  
  auth.on('tokens', async (tokens) => {
    const existingCredentials = JSON.parse(await fs.readFile(TOKEN_PATH, 'utf-8'));
    if (tokens.refresh_token) existingCredentials.refresh_token = tokens.refresh_token;
    if (tokens.access_token) {
      existingCredentials.access_token = tokens.access_token;
      existingCredentials.expiry_date = tokens.expiry_date;
    }
    await fs.writeFile(TOKEN_PATH, JSON.stringify(existingCredentials));
  });

  return auth;
}

async function setupClassroomClient() {
  const auth = await loadCredentials();
  return google.classroom({ version: 'v1', auth });
}

server.tool("courses", {}, async () => {
  try {
    const classroom = await setupClassroomClient();
    const courses = await classroom.courses.list(); 
    return { content: [{ type: "text", text: JSON.stringify(courses.data) }] };
  } catch (error) {
    return { content: [{ type: "text", text: `Error: ${error.message}` }] };
  }
});

server.tool("course-details",
  { courseId: z.string().describe("The ID of the course to get details for") },
  async ({ courseId }) => {
    try {
      const classroom = await setupClassroomClient();
      const courseDetails = await classroom.courses.get({ id: courseId });
      const announcements = await classroom.courses.announcements.list({ courseId, pageSize: 20 });
      return {
        content: [{ type: "text", text: JSON.stringify({
          courseDetails: courseDetails.data,
          announcements: announcements.data.announcements || []
        }, null, 2) }]
      };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }] };
    }
  }
);

server.tool("assignments",
  { courseId: z.string().describe("The ID of the course to get assignments for") },
  async ({ courseId }) => {
    try {
      const classroom = await setupClassroomClient();
      const courseWork = await classroom.courses.courseWork.list({ courseId, pageSize: 50 });
      return {
        content: [{ type: "text", text: JSON.stringify({
          courseId,
          assignments: courseWork.data.courseWork || []
        }, null, 2) }]
      };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }] };
    }
  }
);

server.tool("list_homework_materials",
  { courseId: z.string().describe("The ID of the course") },
  async ({ courseId }) => {
    try {
      const classroom = await setupClassroomClient();
      const materials = await classroom.courses.courseWorkMaterials.list({ courseId });
      return { content: [{ type: "text", text: JSON.stringify(materials.data, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }] };
    }
  }
);

server.tool("read_workspace_file",
  { filePath: z.string().describe("The relative path to the file in /workspace/user/") },
  async ({ filePath }) => {
    if (!isSafePath(filePath)) {
      return { content: [{ type: "text", text: "Error: Access denied. Path must be within /workspace/user/" }] };
    }
    try {
      const content = await fs.readFile(path.resolve(WORKSPACE_ROOT, filePath), 'utf8');
      return { content: [{ type: "text", text: content }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }] };
    }
  }
);

server.tool("write_workspace_file",
  { 
    filePath: z.string().describe("The relative path where the file should be saved"),
    content: z.string().describe("The text content to write")
  },
  async ({ filePath, content }) => {
    if (!isSafePath(filePath)) {
      return { content: [{ type: "text", text: "Error: Access denied. Path must be within /workspace/user/" }] };
    }
    try {
      const fullPath = path.resolve(WORKSPACE_ROOT, filePath);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, content, 'utf8');
      return { content: [{ type: "text", text: `Successfully wrote to ${filePath}` }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }] };
    }
  }
);

async function main() {
  if (process.argv[2] === "auth") {
    await authenticateAndSaveCredentials();
    process.exit(0);
  } else {
    const app = express();
    app.use(express.json());
    let transport;

    app.get("/sse", async (req, res) => {
      transport = new SSEServerTransport("/messages", res);
      await server.connect(transport);
    });

    app.post("/messages", async (req, res) => {
      if (transport) {
        await transport.handlePostMessage(req, res);
      } else {
        res.status(400).send("No active SSE connection");
      }
    });

    app.post("/webhook", async (req, res) => {
      console.log("Received Poke Inbound Message:", req.body);
      res.status(200).send("Webhook received");
    });

    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
      console.error(`SSE & Webhook Server listening on port ${PORT}`);
    });
  }
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});