# Architecture & Implementation Plan: Brain-Tree Context Routing

> [!NOTE]
> **Implementation Status**: Fully implemented. Steps 1 through 4 are complete: `host-laya` implements the FastAPI decisions service, `brain-core` provides vault scanning, compiling, and traversal algorithms, `pi-traverser` provides the Pi extension with circuit breaker and per-session deduplication, and `brain-keeper` provides vault maintenance tools and MCP server support.
> Note on VRAM: The ModernBERT-large English checkpoint requires ~1.7 GB VRAM in fp32 (or ~0.9 GB in bf16/fp16).

## System Overview & Mental Model

This system implements **System-1 Dynamic Few-Shot Routing** for local LLM agents. Instead of passing massive monolithic system prompts or relying entirely on semantic vector search (RAG), the system routes incoming user prompts through a hierarchical decision tree (an Obsidian vault) using high-speed non-autoregressive decision models (**Laya** or **TypeSafe Jev**).

```
[User Prompt]
      │
      ▼
[Pi Harness Hook: before_prompt]
      │
      ▼
[Brain Traverser] <─── HTTP ───> [Decisions API: Laya / Jev]
      │                                (sub-40ms per hop)
      ├── Hop 1: Domain Selection (<= 15 branches)
      ├── Hop 2: Subdomain / Topic (<= 15 branches)
      └── Hop 3: Leaf Document Identification (.md)
      │
      ▼
[Context Injection]
      │ (Prepend leaf markdown as dynamic few-shot/system context)
      ▼
[llama.cpp (Qwen 27B)]
```

### The Invariant: Maximum Branching Factor ($\le 15$)
Decision models like Laya (built on ModernBERT-large) evaluate questions in a single forward pass by reserving an option-token budget (192 tokens for English, 256 for multilingual). 
* At **75 options**, each label receives only 2–3 tokens, causing severe attention degradation.
* At **$\le 15$ options**, each branch receives 12–15 tokens of rich descriptive criteria, maintaining peak calibration and argmax accuracy.
* Traversal cost scales logarithmically: a 2-level tree supports up to 225 targeted leaves with an end-to-end routing latency of roughly 70 ms.

---

## Part 1: Hosting Laya as a Jev-Compatible Decisions API

The goal is to expose Laya locally behind a service interface that mirrors the TypeSafe Jev Decisions API specification (`POST /v1/decisions`), allowing seamless swapping between local inference and the remote cloud API without modifying client code.

```
       [Pi Harness Client]
                │
         POST /v1/decisions
                │
     ┌──────────┴──────────┐
     ▼                     ▼
[Local Laya Host]   [Remote Jev API]
```

### Phase 1.1: Runtime Environment & Dependencies
1. **Host Setup**:
   * Set up an isolated Python runtime (Python 3.10+ recommended for PyTorch and ModernBERT stability).
   * Install core dependencies: `torch` with CUDA acceleration, `transformers`, `laya`, and an asynchronous ASGI web framework (`fastapi`, `uvicorn`).
   * Verify environment variable overrides: set `USE_TF=0` to prevent TensorFlow import deadlocks during transformer initialization.
2. **Device & VRAM Allocation**:
   * Verify GPU availability. Laya requires $< 1\text{ GB}$ of VRAM. It can reside comfortably on the same GPU hosting `llama.cpp` or offloaded entirely to CPU (where single-pass inference runs in $\sim 150$–$250\text{ ms}$).

### Phase 1.2: API Design & Protocol Parity
1. **Schema Harmonization**:
   * Define the request contract matching Jev:
     * `state`: The input prompt string or structured context map.
     * `questions`: A keyed dictionary containing `type` (`choice`, `score`, `noul`), `instructions`, and `criteria`.
   * Define the response contract:
     * Unique request identifier (`id`), timestamp, model identifier, and an `answers` payload returning `choice`, `confidence`, and full probability distributions.
2. **Translation Layer**:
   * Map incoming Jev-style request dictionaries directly into Laya's internal `predict(state, questions)` schema.
   * Format Laya's returned argmax results and softmax scores into Jev's output envelope.

### Phase 1.3: High-Performance Lifecycle Management
1. **Preloading Checkpoints**:
   * Initialize `laya.Router(preload=True, device="cuda")` inside the application startup lifecycle (e.g., FastAPI Lifespan).
   * *Critical requirement*: Avoid on-demand model initialization per request. Cold-loading checkpoints incurs a 7–10 second delay; keeping checkpoints resident in memory guarantees 30–40 ms execution.
2. **Concurrency & Thread Safety**:
   * Run inference in an async-compatible execution thread or lightweight worker pool to avoid blocking the event loop on transformer forward passes.
3. **Graceful Shutdown**:
   * Register explicit cleanup handlers to call `router.unload()` and flush CUDA memory when terminating the service.

### Phase 1.4: Validation & Benchmarking
1. **Functional Test**: Send a mock 4-option routing question to verify response format and schema conformity.
2. **Latency Test**: Benchmark 100 consecutive requests. Confirm p50 latency is $\le 40\text{ ms}$ on GPU.
3. **Parity Check**: Run an identical payload against the remote Jev API and the local Laya service to ensure client code can parse both responses interchangeably.

---

## Part 2: Pi Harness Extension & Tree Traversal Engine

The goal is to build an extension for your Pi coding harness that intercepts agent execution, navigates the Brain Tree, and injects the most relevant `.md` leaf into the agent's context window.

```
Incoming Prompt
      │
[Traverser] ──> Read Directory Manifest (_index.json)
      │
[Decisions Client] ──> POST /v1/decisions (Local Laya or Remote Jev)
      │
Choice Selected ──> Is it Branch or Leaf?
      ├── Branch: Recurse into Child Directory
      └── Leaf: Read .md Content ──> Append to System Prompt
```

### Phase 2.1: Decisions API Client Adapter
1. **Client Construction**:
   * Implement a modular HTTP client accepting `baseUrl` and optional `apiKey`.
   * Configure a default endpoint pointing to `http://localhost:8081` (local Laya) with the ability to override with `https://api.typesafe.ai` (remote Jev) via configuration.
2. **Typed Decision Helper**:
   * Implement an isolated method: `pickChoice(stateText, instructions, criteriaMap)`.
   * Ensure standard timeout configuration (tight timeout of $\le 500\text{ ms}$ for local, $\le 2000\text{ ms}$ for remote API).
   * Include robust error boundaries to handle network timeouts or malformed model responses without crashing the agent harness.

### Phase 2.2: Deterministic Tree Traversal Logic
1. **Traversal Loop**:
   * Start at the designated root folder of the Brain Tree.
   * Read the current directory's manifest (`_index.json`).
   * Extract child descriptors (maximum 15 items per node) and format them into the decision criteria map: `{ child_id: criteria_text }`.
   * Query the decision engine for the optimal child choice.
2. **Terminal Node Handling**:
   * If the chosen node is marked as `branch`: update current path to the target subdirectory and continue to the next hop.
   * If the chosen node is marked as `leaf`: read the target `.md` file from disk and return its full raw contents.
3. **Safety & Fallback Guardrails**:
   * **Max-Hop Ceiling**: Hard-code a maximum traversal depth (e.g., 4 hops) to prevent infinite loops.
   * **Confidence Gating**: Check the model's confidence score at each hop. If confidence drops below a defined threshold (e.g., $< 0.40$), stop traversal immediately or fall back to a predefined default guide (e.g., `general_instructions.md`).
   * **Missing Index Handling**: If a folder lacks an index file, fail gracefully and return `null` rather than terminating the agent process.

### Phase 2.3: Pi Harness Lifecycle Hook
1. **Extension Factory Setup**:
   * Structure the extension adhering to the harness interface (`extensionFactories`).
   * Register a hook listener for the prompt interception event (e.g., `before_prompt` or `agent_start`).
2. **Context Injection Strategy**:
   * Receive the user's initial input text.
   * Pass the prompt through the traversal engine to fetch the matching markdown leaf.
   * Format the retrieved document into a clearly demarcated prompt section (e.g., `[Reference Guide: <Title>]`).
   * Prepend or append the document to the agent's active system prompt before sending the final request to `llama.cpp`.
3. **Tracing & Observability**:
   * Log the traversal trail (e.g., `Root -> Backend -> Database -> postgres_indexing.md`) and the decision engine's confidence scores to the harness debug console.

---

## Part 3: Brain Management (Obsidian Vault Architecture)

The goal is to maintain the knowledge base inside an Obsidian vault where notes remain human-readable and easy to write, while an automated build step validates the tree structure and compiles fast machine-readable index manifests.

```
[Obsidian Vault] ──(Human Authoring: YAML + Markdown)
       │
       ▼
[Compiler Script] ──(Validation: Checks <= 15 Children Rule)
       │
       ▼
[_index.json Manifests] ──(Machine Consumption by Traverser)
```

### Phase 3.1: Vault Taxonomy & Directory Hierarchy
1. **Top-Level Domain Design**:
   * Group high-level competencies into $\le 15$ top-level folders (e.g., `Architecture`, `Language-Specs`, `Frameworks`, `Infrastructure`, `Testing`).
2. **Sub-Branch Organization**:
   * Keep folder structures strictly categorical.
   * Never allow a folder to contain more than 15 items (subdirectories + markdown files combined).
3. **Folder Metadata Definition**:
   * For every folder (branch), create an optional folder-note or `_about.md` containing a high-level summary of what belongs inside that domain. This forms the criteria text when parent nodes are evaluated.

### Phase 3.2: Frontmatter Standards for Leaf Notes
1. **Standardized Schema**:
   * Every leaf `.md` file must define structured YAML frontmatter at the top of the file:
     * `id`: Short, unique identifier slug.
     * `title`: Human-readable display title.
     * `criteria`: A 10–25 word description explicitly detailing *when* this document should be selected. Focus on trigger words, domain keywords, and typical user intents.
     * `fallback`: (Optional) Boolean flag marking general catch-all notes.
2. **Guidelines for Writing Effective Criteria**:
   * Write criteria as distinct domain discriminators, not generic summaries.
   * *Ineffective criteria*: "Everything about writing code."
   * *Effective criteria*: "FastAPI routing, dependency injection, async database connections, and uvicorn configuration."

### Phase 3.3: Static Compiler & Structural Validator
1. **Tree Scanning Routine**:
   * Write a stand-alone Python or Node.js compilation script (`compile_brain.py` or `compile_brain.ts`).
   * Recursively scan the vault starting from the root directory.
   * Parse YAML frontmatter from every `.md` file using a robust parser.
2. **Invariant Enforcer ($\le 15$ Rule)**:
   * Count total children (subfolders + markdown files) at each directory node.
   * If any folder exceeds 15 children, raise a blocking validation error. Output clear instructions indicating which folder needs to be partitioned into subcategories.
3. **Manifest Generation (`_index.json`)**:
   * For each directory, output a lightweight JSON file containing:
     * Node ID.
     * Type (`branch` or `leaf`).
     * Routing criteria string.
     * Target filesystem path.
   * Save `_index.json` locally in that directory. The traverser reads this file directly, eliminating filesystem scanning overhead during request routing.

### Phase 3.4: Authoring & Sync Workflows
1. **Manual Compilation CLI**:
   * Provide a one-command CLI task (e.g., `npm run brain:build`) to re-index the vault after making changes in Obsidian.
2. **Automated File-Watcher Option**:
   * Implement a background watcher daemon using file-system events (`chokidar` or `watchdog`) that detects file saves in the vault and automatically recompiles affected sub-indices.
3. **Obsidian Integration**:
   * Rely on standard Obsidian plugins (such as Obsidian Templater) to scaffold new notes with the required YAML frontmatter fields pre-populated.

---

## Technical Specifications & Schema Reference

### 1. Unified Decisions Protocol (`/v1/decisions`)

#### Request Contract
```json
{
  "model": "laya",
  "state": "How do I configure connection pooling for asyncpg in FastAPI?",
  "questions": {
    "route_selection": {
      "type": "choice",
      "instructions": "Select the reference manual most relevant to the developer prompt.",
      "criteria": {
        "fastapi_core": "FastAPI routing, request lifecycle, middleware, and dependency injection",
        "asyncpg_pooling": "PostgreSQL database connections, asyncpg pools, and session management",
        "docker_deploy": "Dockerfile setups, container networking, and compose files"
      }
    }
  }
}
```

#### Response Contract
```json
{
  "id": "dec_8f7b2c019a3e",
  "model": "laya-multilingual",
  "created_at": 1790093235.12,
  "answers": {
    "route_selection": {
      "type": "choice",
      "choice": "asyncpg_pooling",
      "confidence": 0.942,
      "probabilities": {
        "fastapi_core": 0.041,
        "asyncpg_pooling": 0.942,
        "docker_deploy": 0.017
      }
    }
  },
  "routing": {
    "model": "laya-multilingual",
    "latency_ms": 34.2
  }
}
```

### 2. Vault Manifest Schema (`_index.json`)

```json
[
  {
    "id": "fastapi_core",
    "type": "leaf",
    "criteria": "FastAPI routing, request lifecycle, middleware, and dependency injection",
    "targetPath": "fastapi_core.md"
  },
  {
    "id": "database_systems",
    "type": "branch",
    "criteria": "Database configurations, migrations, SQL queries, and ORM usage",
    "targetPath": "Databases"
  }
]
```

---

## Step-by-Step Execution Roadmap

```
Step 1: Local Server
  ├── Set up FastAPI + laya
  ├── Implement Jev-compatible /v1/decisions endpoint
  └── Verify sub-40ms execution on test schema

Step 2: Brain Structure & Compiler
  ├── Create Obsidian vault directory layout
  ├── Draft 5-10 sample .md notes with criteria frontmatter
  ├── Write compilation script to enforce <= 15 limit
  └── Generate _index.json manifests

Step 3: Pi Harness Extension
  ├── Write decisions HTTP client (with Jev fallback support)
  ├── Implement tree traversal logic reading manifests
  └── Hook into harness prompt lifecycle to inject context

Step 4: End-to-End System Test
  ├── Start Laya server on :8081
  ├── Start llama.cpp (Qwen 27B) on :8080
  ├── Issue test prompt via Pi Harness
  └── Verify correct leaf is selected, attached, and processed
```

### Step 1: The Decisions Host (Laya)
- [x] Initialize Python environment and verify PyTorch + CUDA functionality.
- [x] Build the FastAPI microservice adhering to the `/v1/decisions` contract.
- [x] Implement preloading of Laya checkpoints on startup.
- [x] Benchmark local inference latency and verify responses match the expected format.

### Step 2: The Knowledge Base Structure (Vault & Compiler)
- [x] Create the Obsidian vault directory structure.
- [x] Draft 5–10 sample leaf markdown notes covering distinct domains with frontmatter criteria.
- [x] Implement the compilation script to parse frontmatter and enforce the $\le 15$ children invariant.
- [x] Run compilation and inspect generated `_index.json` manifests for structural integrity.

### Step 3: The Pi Harness Integration
- [x] Implement the TypeScript Decisions Client with support for both local Laya and remote Jev endpoints.
- [x] Implement the Brain Traverser to recursively read `_index.json` files and select branches/leaves.
- [x] Wire the traverser into the Pi Harness extension hooks to enrich system prompts.
- [x] Add confidence thresholds and fallback paths for unclassifiable prompts.

### Step 4: End-to-End System Validation
- [x] Launch the Laya Decisions microservice on port 8081.
- [x] Launch the local LLM (`llama.cpp` hosting Qwen) on port 8080.
- [x] Send real-world programming queries to the Pi Harness.
- [x] Confirm that:
  1. Routing hops take $< 100\text{ ms}$ total.
  2. The expected markdown guide is accurately selected.
  3. Qwen leverages the injected few-shot/reference instructions in its final completion.