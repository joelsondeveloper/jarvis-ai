# 🤖 JARVIS

> Personal AI assistant built with the JavaScript ecosystem.

JARVIS is an experimental personal AI assistant designed to interact with the user, understand natural language, use tools, automate tasks and eventually execute complex tasks autonomously.

The project is being developed from scratch as both a real-world software project and a learning experience focused on backend development, AI agents, automation and system architecture.

---

## 🚀 Vision

The goal is to build an assistant capable of:

* 💬 Understanding natural language
* 🧠 Maintaining short-term and long-term memory
* 🛠️ Using tools to interact with the computer
* 💻 Creating and executing scripts when necessary
* 📁 Reading and modifying files
* 🌐 Interacting with the web
* 🎙️ Understanding voice commands
* 🔊 Responding through voice
* ⚙️ Automating repetitive tasks
* 🧩 Extending its own capabilities through new tools
* 🤖 Planning and executing multi-step tasks

---

## 🏗️ Architecture

The project will be built around a modular architecture:

```text
                    JARVIS
                       │
                    AGENT
                       │
          ┌────────────┼────────────┐
          │            │            │
          ▼            ▼            ▼
         AI          TOOLS        MEMORY
          │            │            │
          ▼            ▼            ▼
       LLMs        System/API    Database
                       │
                       ▼
                 Code Execution
                    Sandbox
```

The AI model will be separated from the core application through an abstraction layer, allowing JARVIS to work with different AI providers, including local models.

---

## 🧰 Tech Stack

### Core

* TypeScript
* Node.js
* Express.js

### AI

* LLM providers
* Local AI models
* Tool calling

### Data

* SQLite
* PostgreSQL
* Drizzle ORM

### Communication

* REST API
* WebSockets

### Future

* Speech-to-Text
* Text-to-Speech
* React
* Desktop application
* Browser automation

---

## 📂 Project Structure

The architecture will evolve as the project grows.

```text
src/
├── ai/
├── agent/
├── tools/
├── memory/
├── voice/
├── api/
└── index.ts
```

Each module will have a specific responsibility, keeping the system modular and easier to maintain.

---

## 🗺️ Roadmap

### Phase 1 • Foundation

* [ ] Project setup
* [ ] Express server
* [ ] TypeScript configuration
* [ ] Environment variables
* [ ] Basic API
* [ ] AI provider abstraction

### Phase 2 • Agent

* [ ] Conversation system
* [ ] Agent loop
* [ ] Context management
* [ ] Tool system
* [ ] Tool calling

### Phase 3 • Computer Control

* [ ] File system tools
* [ ] Application control
* [ ] Terminal commands
* [ ] Script execution
* [ ] Permission system
* [ ] Sandboxed execution

### Phase 4 • Memory

* [ ] Conversation history
* [ ] Short-term memory
* [ ] Persistent memory
* [ ] Semantic search

### Phase 5 • Voice

* [ ] Speech-to-Text
* [ ] Wake word
* [ ] Text-to-Speech
* [ ] Voice interaction

### Phase 6 • Interface

* [ ] Web interface
* [ ] Real-time communication
* [ ] Desktop application
* [ ] JARVIS dashboard

### Phase 7 • Autonomous Agent

* [ ] Task planning
* [ ] Multi-step execution
* [ ] Error recovery
* [ ] Self-evaluation
* [ ] Dynamic tool usage

---

## 🎯 Current Status

**Early development**

The project is currently being built from the ground up, with each component being implemented and documented as part of the learning process.

---

## 📚 What I'm Learning

This project is also a practical study of:

* Backend architecture
* TypeScript
* Express.js
* APIs
* AI agents
* LLM integration
* Tool calling
* Dependency management
* Databases
* WebSockets
* Automation
* System programming
* Software architecture

---

## ⚠️ Security

JARVIS is intended to eventually interact with the host system.

Because AI-generated code and commands can be dangerous, system-level operations will be implemented with explicit permissions, validation and sandboxing whenever possible.

---

## 📜 License

This project is currently experimental and intended primarily for learning and development.
