/**
 * Continuity Plugin for OpenClaw
 *
 * Provides persistent continuity management for AI agents:
 * - Append-only action stream (JSONL format)
 * - Integrity verification with hash chaining
 * - Automatic session continuity restoration on restart
 * - Pre-compaction checkpointing
 * - Health checks and integrity validation
 *
 * Based on the continuity skill principles:
 * https://github.com/openmetaloom/skills/tree/master/continuity
 *
 * Uses pr-12082 lifecycle interception hooks for:
 * - before_tool_call: Log all actions before they execute
 * - before_compaction: Capture pre-compaction checkpoints
 * - message_received/message_sending/message_sent: Bidirectional logging
 * - before_agent_start/agent_end: Agent lifecycle management
 */

import type { OpenClawPluginApi } from "../../plugin-sdk/index.js";
import type {
  PluginHookBeforeToolCallEvent,
  PluginHookBeforeToolCallResult,
  PluginHookToolContext,
  PluginHookBeforeCompactionEvent,
  PluginHookAgentContext,
  PluginHookMessageReceivedEvent,
  PluginHookMessageReceivedResult,
  PluginHookMessageSendingEvent,
  PluginHookMessageSendingResult,
  PluginHookMessageSentEvent,
  PluginHookMessageContext,
  PluginHookBeforeAgentStartEvent,
  PluginHookAgentEndEvent,
  PluginHookAfterToolCallEvent,
  PluginHookToolErrorEvent,
} from "../../plugins/types.js";

import {
  ContinuityStore,
  type ContinuityConfig,
  type ActionEntry,
  type LogLevel,
} from "./lib/store.js";
import { IntegrityValidator } from "./lib/integrity.js";
import { CheckpointManager } from "./lib/checkpoint.js";
import { HealthChecker } from "./lib/health.js";
import { SessionRestorer } from "./lib/session.js";
import path from "node:path";
import os from "node:os";

// Default configuration
const DEFAULT_CONFIG: Partial<ContinuityConfig> = {
  logLevel: "everything",
  storagePath: path.join(os.homedir(), ".openclaw", "continuity"),
  enableIntegrityCheck: true,
  enablePreCompactionCheckpoint: true,
  blockOnPersistenceFailure: true,
  maxBackupFiles: 24,
  criticalToolPatterns: ["write", "edit", "exec", "message", "browser", "nodes", "process"],
  implicitResumeThresholdMinutes: 30,
};

// Global state (per-plugin-instance)
let store: ContinuityStore | null = null;
let integrityValidator: IntegrityValidator | null = null;
let checkpointManager: CheckpointManager | null = null;
let healthChecker: HealthChecker | null = null;
let sessionRestorer: SessionRestorer | null = null;
let currentSessionId: string | null = null;

/**
 * Check if a tool name matches critical patterns
 */
function isCriticalTool(toolName: string, patterns: string[]): boolean {
  const normalizedName = toolName.toLowerCase();
  return patterns.some(pattern => 
    normalizedName.includes(pattern.toLowerCase())
  );
}

/**
 * Get current timestamp in ISO format
 */
function getTimestamp(): string {
  return new Date().toISOString();
}

/**
 * Generate a unique action ID
 */
function generateActionId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 11)}`;
}

/**
 * Initialize the continuity plugin
 */
async function initializeContinuity(api: OpenClawPluginApi): Promise<void> {
  const pluginConfig = (api.pluginConfig || {}) as Partial<ContinuityConfig>;
  
  // Merge with defaults
  const config: ContinuityConfig = {
    ...DEFAULT_CONFIG,
    ...pluginConfig,
  } as ContinuityConfig;

  // Resolve storage path (handle ~ expansion)
  if (config.storagePath.startsWith("~")) {
    config.storagePath = path.join(os.homedir(), config.storagePath.slice(1));
  }

  api.logger.info(`[continuity] Initializing with storage at: ${config.storagePath}`);

  // Initialize components
  store = new ContinuityStore(config, api.logger);
  await store.initialize();

  if (config.enableIntegrityCheck) {
    integrityValidator = new IntegrityValidator(config.storagePath, api.logger);
  }

  if (config.enablePreCompactionCheckpoint) {
    checkpointManager = new CheckpointManager(config.storagePath, api.logger);
  }

  healthChecker = new HealthChecker(store, integrityValidator, api.logger);
  sessionRestorer = new SessionRestorer(store, api.logger);

  api.logger.info("[continuity] Plugin initialized successfully");
}

/**
 * Shutdown the continuity plugin
 */
async function shutdownContinuity(api: OpenClawPluginApi): Promise<void> {
  api.logger.info("[continuity] Shutting down...");

  if (store) {
    await store.close();
  }

  // Clear references
  store = null;
  integrityValidator = null;
  checkpointManager = null;
  healthChecker = null;
  sessionRestorer = null;
  currentSessionId = null;

  api.logger.info("[continuity] Plugin shutdown complete");
}

/**
 * Main plugin entry point
 */
export default function continuityPlugin(api: OpenClawPluginApi): void {
  const logger = api.logger;

  // Register lifecycle hooks using the new API
  
  // ============================================================================
  // BOOT / SHUTDOWN
  // ============================================================================
  
  api.lifecycle.on("boot.post", async (payload, context) => {
    logger.debug?.("[continuity] Boot post - initializing");
    await initializeContinuity(api);
    
    // Verify continuity on startup
    if (healthChecker) {
      const health = await healthChecker.check();
      if (!health.healthy) {
        logger.warn(`[continuity] Health check issues: ${health.issues.join(", ")}`);
      } else {
        logger.info("[continuity] Health check passed");
      }
    }
  });

  api.lifecycle.on("shutdown.pre", async (payload, context) => {
    logger.debug?.("[continuity] Shutdown pre - cleaning up");
    await shutdownContinuity(api);
  });

  // ============================================================================
  // SESSION MANAGEMENT
  // ============================================================================
  
  api.on("before_agent_start", async (event: PluginHookBeforeAgentStartEvent, ctx: PluginHookAgentContext) => {
    logger.debug?.(`[continuity] Agent starting: ${ctx.agentId}`);

    if (store?.config.logLevel === "off") {
      return;
    }

    // Check for explicit session resumption
    if (event.resumedFrom && sessionRestorer) {
      logger.info(`[continuity] Explicit session resumption from: ${event.resumedFrom}`);
      const restoredContext = await sessionRestorer.restoreContext(event.resumedFrom);
      
      if (restoredContext) {
        // Log the explicit restoration
        const restoreAction: ActionEntry = {
          id: generateActionId(),
          timestamp: getTimestamp(),
          type: "continuity_restore",
          severity: "medium",
          platform: "openclaw",
          description: `Continuity restored from session ${event.resumedFrom}: ${restoredContext.recentActions.length} recent actions`,
          sessionId: currentSessionId || undefined,
          metadata: {
            resumedFrom: event.resumedFrom,
            continuityGap: restoredContext.continuityGap,
            actionCount: restoredContext.recentActions.length,
            agentId: ctx.agentId,
          },
        };
        await store?.logAction(restoreAction);

        // Store context for the agent to access
        (ctx as Record<string, unknown>).continuityContext = restoredContext;
      }
    }

    // Check for implicit session resumption (recent activity but resumedFrom is null)
    if (!event.resumedFrom && sessionRestorer && store) {
      const thresholdMinutes = store.config.implicitResumeThresholdMinutes || 30;
      const implicitResult = await sessionRestorer.detectImplicitResumption(thresholdMinutes);
      
      if (implicitResult.shouldRestore && implicitResult.recentContext) {
        logger.info(`[continuity] Implicit session resumption detected (${implicitResult.gapMinutes.toFixed(1)} min gap)`);
        
        // Log the implicit restoration
        const implicitRestoreAction: ActionEntry = {
          id: generateActionId(),
          timestamp: getTimestamp(),
          type: "continuity_implicit_restore",
          severity: "medium",
          platform: "openclaw",
          description: `Implicitly restored context: ${implicitResult.recentContext.totalActions} actions in last hour, gap was ${implicitResult.gapMinutes.toFixed(1)} minutes`,
          sessionId: currentSessionId || undefined,
          metadata: {
            gapMinutes: implicitResult.gapMinutes,
            thresholdMinutes: implicitResult.thresholdMinutes,
            lastActivityTime: implicitResult.lastActivityTime,
            recentActionCount: implicitResult.recentContext.totalActions,
            recentSessions: implicitResult.recentContext.sessions,
            agentId: ctx.agentId,
          },
        };
        await store.logAction(implicitRestoreAction);
        
        // Store context for the agent to access
        (ctx as Record<string, unknown>).continuityContext = implicitResult.recentContext;
      }
    }

    // Log agent start
    const action: ActionEntry = {
      id: generateActionId(),
      timestamp: getTimestamp(),
      type: "agent_start",
      severity: "low",
      platform: "openclaw",
      description: `Agent started: ${ctx.agentId}`,
      sessionId: currentSessionId || undefined,
      metadata: {
        agentId: ctx.agentId,
        messageCount: event.messages.length,
        resumedFrom: event.resumedFrom,
      },
    };

    await store?.logAction(action);
  });

  api.on("agent_end", async (event: PluginHookAgentEndEvent, ctx: PluginHookAgentContext) => {
    logger.debug?.(`[continuity] Agent ended: ${ctx.agentId}`);

    if (store?.config.logLevel === "off") {
      return;
    }

    // Log agent end
    const action: ActionEntry = {
      id: generateActionId(),
      timestamp: getTimestamp(),
      type: "agent_end",
      severity: "low",
      platform: "openclaw",
      description: `Agent ended: ${ctx.agentId} (${event.messages.length} messages)`,
      sessionId: currentSessionId || undefined,
      metadata: {
        messageCount: event.messages.length,
        durationMs: event.durationMs,
        success: event.success,
        error: event.error,
        agentId: ctx.agentId,
      },
    };

    await store?.logAction(action);
  });

  // ============================================================================
  // TOOL CALL INTERCEPTION (BEFORE EXECUTION)
  // ============================================================================
  
  api.on("before_tool_call", async (
    event: PluginHookBeforeToolCallEvent,
    ctx: PluginHookToolContext
  ): Promise<PluginHookBeforeToolCallResult | void> => {
    const toolName = event.toolName;
    const params = event.params;
    const config = store?.config;

    // Skip if logging is disabled or store not initialized
    if (!config || config.logLevel === "off") {
      return;
    }

    if (!store) {
      logger.error("[continuity] Store not initialized");
      return config.blockOnPersistenceFailure
        ? { block: true, blockReason: "Store not initialized" }
        : undefined;
    }

    // Determine severity based on tool type
    const isCritical = isCriticalTool(toolName, config.criticalToolPatterns);
    const severity = isCritical ? "critical" : "medium";

    logger.debug?.(`[continuity] Before tool call: ${toolName} (severity: ${severity})`);

    // For critical tools with side effects, we MUST log before execution
    // This implements the "synchronous persistence" principle
    if (isCritical) {
      const action: ActionEntry = {
        id: generateActionId(),
        timestamp: getTimestamp(),
        type: "tool_call",
        severity,
        platform: "openclaw",
        description: `Tool call: ${toolName}`,
        toolName,
        toolParams: params,
        sessionId: currentSessionId || undefined,
        metadata: {
          agentId: ctx.agentId,
          sessionKey: ctx.sessionKey,
        },
      };

      try {
        const persisted = await store.logAction(action);
        
        if (!persisted && config.blockOnPersistenceFailure) {
          logger.error(`[continuity] CRITICAL: Failed to persist action for ${toolName}`);
          return {
            block: true,
            blockReason: "Continuity persistence failure - action blocked for safety",
          };
        }

        // Add action ID to params for correlation with result
        if (persisted) {
          (params as Record<string, unknown>).__continuity_action_id = action.id;
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.error(`[continuity] Error logging action: ${errorMsg}`);
        
        if (config.blockOnPersistenceFailure) {
          return {
            block: true,
            blockReason: `Continuity logging error: ${errorMsg}`,
          };
        }
      }
    } else if (config.logLevel === "everything") {
      // For non-critical tools, log if "everything" mode is enabled
      const action: ActionEntry = {
        id: generateActionId(),
        timestamp: getTimestamp(),
        type: "tool_call",
        severity,
        platform: "openclaw",
        description: `Tool call: ${toolName}`,
        toolName,
        toolParams: params,
        sessionId: currentSessionId || undefined,
        metadata: {
          agentId: ctx.agentId,
          sessionKey: ctx.sessionKey,
        },
      };

      await store.logAction(action).catch(err => {
        logger.warn(`[continuity] Non-critical action log failed: ${err}`);
      });
    }
  });

  // ============================================================================
  // TOOL CALL RESULTS (AFTER EXECUTION)
  // ============================================================================
  
  api.on("after_tool_call", async (event: PluginHookAfterToolCallEvent, ctx: PluginHookToolContext) => {
    if (!store) {
      logger.error("[continuity] Store not initialized");
      return;
    }

    const config = store.config;
    if (config.logLevel === "off") {
      return;
    }

    // Get the action ID from the params if it was added
    const actionId = (event.params as Record<string, unknown>).__continuity_action_id as string | undefined;
    
    const action: ActionEntry = {
      id: generateActionId(),
      timestamp: getTimestamp(),
      type: "tool_result",
      severity: event.error ? "high" : "low",
      platform: "openclaw",
      description: event.error 
        ? `Tool ${event.toolName} failed: ${event.error}` 
        : `Tool ${event.toolName} completed`,
      toolName: event.toolName,
      sessionId: currentSessionId || undefined,
      parentActionId: actionId,
      metadata: {
        success: !event.error,
        error: event.error,
        durationMs: event.durationMs,
        agentId: ctx.agentId,
        sessionKey: ctx.sessionKey,
      },
    };

    await store?.logAction(action).catch(err => {
      logger.warn(`[continuity] Failed to log tool result: ${err}`);
    });
  });

  api.on("tool_error", async (event: PluginHookToolErrorEvent, ctx: PluginHookToolContext) => {
    if (!store) {
      logger.error("[continuity] Store not initialized");
      return;
    }

    const config = store.config;
    if (config.logLevel === "off") {
      return;
    }

    const action: ActionEntry = {
      id: generateActionId(),
      timestamp: getTimestamp(),
      type: "tool_error",
      severity: "high",
      platform: "openclaw",
      description: `Tool ${event.toolName} error: ${event.error}`,
      toolName: event.toolName,
      sessionId: currentSessionId || undefined,
      metadata: {
        error: event.error,
        durationMs: event.durationMs,
        agentId: ctx.agentId,
        sessionKey: ctx.sessionKey,
      },
    };

    await store?.logAction(action).catch(err => {
      logger.warn(`[continuity] Failed to log tool error: ${err}`);
    });
  });

  // ============================================================================
  // MESSAGE BIDIRECTIONAL LOGGING
  // ============================================================================
  
  api.on("message_received", async (
    event: PluginHookMessageReceivedEvent,
    ctx: PluginHookMessageContext
  ): Promise<PluginHookMessageReceivedResult | void> => {
    if (!store) {
      logger.error("[continuity] Store not initialized");
      return;
    }

    const config = store.config;
    if (config.logLevel === "off") {
      return;
    }

    logger.debug?.(`[continuity] Message received from ${event.from} on ${ctx.channelId}`);

    const action: ActionEntry = {
      id: generateActionId(),
      timestamp: new Date(event.timestamp || Date.now()).toISOString(),
      type: "message_received",
      severity: "low",
      platform: ctx.channelId,
      description: `Message from ${event.from}: ${event.content.substring(0, 100)}${event.content.length > 100 ? "..." : ""}`,
      sessionId: currentSessionId || undefined,
      metadata: {
        from: event.from,
        content: event.content,
        channelId: ctx.channelId,
        accountId: ctx.accountId,
        conversationId: ctx.conversationId,
      },
    };

    await store?.logAction(action).catch(err => {
      logger.warn(`[continuity] Failed to log received message: ${err}`);
    });
  });

  api.on("message_sending", async (
    event: PluginHookMessageSendingEvent,
    ctx: PluginHookMessageContext
  ): Promise<PluginHookMessageSendingResult | void> => {
    if (!store) {
      logger.error("[continuity] Store not initialized");
      return;
    }

    const config = store.config;
    if (config.logLevel === "off") {
      return;
    }

    // For "judgment" level, only log messages that look like decisions/analysis
    if (config.logLevel === "judgment") {
      const content = event.content.toLowerCase();
      const isDecision = /\b(decide|decision|conclude|conclusion|recommend|analysis|think|believe)\b/.test(content);
      if (!isDecision) {
        return;
      }
    }

    logger.debug?.(`[continuity] Message sending to ${event.to} on ${ctx.channelId}`);

    const action: ActionEntry = {
      id: generateActionId(),
      timestamp: getTimestamp(),
      type: "message_sending",
      severity: "low",
      platform: ctx.channelId,
      description: `Response to ${event.to}: ${event.content.substring(0, 100)}${event.content.length > 100 ? "..." : ""}`,
      sessionId: currentSessionId || undefined,
      metadata: {
        to: event.to,
        content: event.content,
        channelId: ctx.channelId,
        accountId: ctx.accountId,
        conversationId: ctx.conversationId,
      },
    };

    await store?.logAction(action).catch(err => {
      logger.warn(`[continuity] Failed to log sending message: ${err}`);
    });
  });

  api.on("message_sent", async (event: PluginHookMessageSentEvent, ctx: PluginHookMessageContext) => {
    if (!store) {
      logger.error("[continuity] Store not initialized");
      return;
    }

    const config = store.config;
    if (config.logLevel === "off") {
      return;
    }

    if (!event.success) {
      // Log failed sends as higher severity
      const action: ActionEntry = {
        id: generateActionId(),
        timestamp: getTimestamp(),
        type: "message_send_failed",
        severity: "high",
        platform: ctx.channelId,
        description: `Failed to send message to ${event.to}: ${event.error}`,
        sessionId: currentSessionId || undefined,
        metadata: {
          to: event.to,
          error: event.error,
          channelId: ctx.channelId,
          accountId: ctx.accountId,
        },
      };

      await store?.logAction(action).catch(err => {
        logger.warn(`[continuity] Failed to log message send failure: ${err}`);
      });
    }
  });

  // ============================================================================
  // COMPACTION CHECKPOINTING
  // ============================================================================
  
  api.on("before_compaction", async (event: PluginHookBeforeCompactionEvent, ctx: PluginHookAgentContext) => {
    logger.info(`[continuity] Pre-compaction checkpoint: ${event.messageCount} messages, ${event.tokenCount || "unknown"} tokens`);

    if (checkpointManager && store?.config.enablePreCompactionCheckpoint) {
      try {
        await checkpointManager.createCheckpoint({
          timestamp: getTimestamp(),
          messageCount: event.messageCount,
          tokenCount: event.tokenCount,
          sessionId: currentSessionId || undefined,
          agentId: ctx.agentId,
          sessionKey: ctx.sessionKey,
        });
        logger.info("[continuity] Pre-compaction checkpoint created successfully");
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.error(`[continuity] Failed to create pre-compaction checkpoint: ${errorMsg}`);
      }
    }

    // Also log the compaction event itself
    if (store && store.config.logLevel !== "off") {
      const action: ActionEntry = {
        id: generateActionId(),
        timestamp: getTimestamp(),
        type: "compaction",
        severity: "medium",
        platform: "openclaw",
        description: `Memory compaction: ${event.messageCount} messages compacted`,
        sessionId: currentSessionId || undefined,
        metadata: {
          messageCount: event.messageCount,
          tokenCount: event.tokenCount,
          agentId: ctx.agentId,
          sessionKey: ctx.sessionKey,
        },
      };

      await store.logAction(action).catch(err => {
        logger.warn(`[continuity] Failed to log compaction event: ${err}`);
      });
    }
  });

  api.on("after_compaction", async (event, ctx) => {
    logger.info(`[continuity] Compaction complete: ${event.compactedCount} messages retained`);

    if (store && store.config.logLevel !== "off") {
      const action: ActionEntry = {
        id: generateActionId(),
        timestamp: getTimestamp(),
        type: "compaction_complete",
        severity: "low",
        platform: "openclaw",
        description: `Memory compaction complete: ${event.compactedCount} messages retained`,
        sessionId: currentSessionId || undefined,
        metadata: {
          compactedCount: event.compactedCount,
          messageCount: event.messageCount,
          tokenCount: event.tokenCount,
          agentId: ctx.agentId,
          sessionKey: ctx.sessionKey,
        },
      };

      await store.logAction(action).catch(err => {
        logger.warn(`[continuity] Failed to log compaction completion: ${err}`);
      });
    }
  });

  // ============================================================================
  // ERROR HANDLING
  // ============================================================================
  
  api.on("agent_error", async (event, ctx) => {
    if (!store || store.config.logLevel === "off") {
      return;
    }

    const action: ActionEntry = {
      id: generateActionId(),
      timestamp: getTimestamp(),
      type: "agent_error",
      severity: "high",
      platform: "openclaw",
      description: `Agent error: ${event.error || "Unknown error"}`,
      sessionId: currentSessionId || undefined,
      metadata: {
        error: event.error,
        success: event.success,
        durationMs: event.durationMs,
        agentId: ctx.agentId,
        sessionKey: ctx.sessionKey,
      },
    };

    await store.logAction(action).catch(err => {
      logger.warn(`[continuity] Failed to log agent error: ${err}`);
    });
  });

  api.on("response_error", async (event, ctx) => {
    if (!store || store.config.logLevel === "off") {
      return;
    }

    const action: ActionEntry = {
      id: generateActionId(),
      timestamp: getTimestamp(),
      type: "response_error",
      severity: "high",
      platform: ctx.channelId,
      description: `Response error to ${event.to}: ${event.error}`,
      sessionId: currentSessionId || undefined,
      metadata: {
        to: event.to,
        error: event.error,
        channelId: ctx.channelId,
        accountId: ctx.accountId,
      },
    };

    await store.logAction(action).catch(err => {
      logger.warn(`[continuity] Failed to log response error: ${err}`);
    });
  });

  logger.info("[continuity] Plugin registered successfully");
}
