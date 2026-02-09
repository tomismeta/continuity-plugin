/**
 * Session Restorer - Continuity restoration on restart
 * 
 * Handles session continuity restoration:
 * - Recovers context from previous sessions
 * - Reconstructs conversation state
 * - Provides summary of recent activity
 */

import type { PluginLogger } from "../../../plugins/types.js";
import type { ContinuityStore, StoredAction } from "./store.js";

export interface ImplicitResumptionResult {
  shouldRestore: boolean;
  lastActivityTime: string;
  gapMinutes: number;
  thresholdMinutes: number;
  recentContext?: {
    period: string;
    totalActions: number;
    sessions: string[];
    highlights: string[];
  };
}

export interface RestoredContext {
  sessionId: string;
  resumedAt: string;
  summary: string;
  recentActions: StoredAction[];
  keyDecisions: StoredAction[];
  activeWorkflows: string[];
  continuityGap?: string;
}

export interface SessionSummary {
  sessionId: string;
  startTime: string;
  endTime?: string;
  durationMs?: number;
  actionCount: number;
  keyEvents: string[];
}

export class SessionRestorer {
  constructor(
    private readonly store: ContinuityStore,
    private readonly logger: PluginLogger
  ) {}

  /**
   * Detect if there's been recent activity that suggests an implicit session resumption.
   * This handles the case when the gateway restarts and creates a fresh session with resumedFrom: null.
   * 
   * @param thresholdMinutes - Maximum gap in minutes to consider as a continuation (default: 30)
   * @returns Result indicating whether implicit resumption should occur
   */
  async detectImplicitResumption(thresholdMinutes: number = 30): Promise<ImplicitResumptionResult> {
    const lastActivityTime = await this.store.getLastActionTime();
    
    // No previous activity
    if (!lastActivityTime) {
      this.logger.debug?.("[session] No previous activity found for implicit resumption");
      return {
        shouldRestore: false,
        lastActivityTime: "",
        gapMinutes: Infinity,
        thresholdMinutes,
      };
    }

    const lastTime = new Date(lastActivityTime).getTime();
    const now = Date.now();
    const gapMinutes = (now - lastTime) / 60000;

    this.logger.debug?.(`[session] Last activity was ${gapMinutes.toFixed(1)} minutes ago (threshold: ${thresholdMinutes})`);

    if (gapMinutes < thresholdMinutes) {
      // Recent activity detected - get context for restoration
      const recentContext = await this.getRecentActivitySummary(1); // Last hour
      
      this.logger.info(`[session] Implicit resumption detected: ${gapMinutes.toFixed(1)} minutes since last activity, ${recentContext.totalActions} recent actions`);
      
      return {
        shouldRestore: true,
        lastActivityTime,
        gapMinutes,
        thresholdMinutes,
        recentContext,
      };
    }

    return {
      shouldRestore: false,
      lastActivityTime,
      gapMinutes,
      thresholdMinutes,
    };
  }

  /**
   * Restore context from a previous session
   */
  async restoreContext(sessionId: string): Promise<RestoredContext | null> {
    this.logger.info(`[session] Restoring context from session ${sessionId}`);

    // Get actions from the session
    const sessionActions = await this.store.queryActions({
      limit: 100,
    });

    // Filter to this session
    const actions = sessionActions.filter(a => a.sessionId === sessionId);
    
    if (actions.length === 0) {
      this.logger.warn(`[session] No actions found for session ${sessionId}`);
      return null;
    }

    // Build summary
    const summary = this.buildSessionSummary(actions, sessionId);
    
    // Extract key decisions (high severity or judgment-type actions)
    const keyDecisions = actions.filter(a => 
      a.severity === "critical" || 
      a.severity === "high" ||
      a.type === "decision" ||
      a.type === "commit"
    );

    // Identify active workflows
    const workflows = this.extractWorkflows(actions);

    // Check for continuity gap
    const lastAction = actions[actions.length - 1];
    const gap = this.calculateContinuityGap(lastAction.timestamp);

    return {
      sessionId,
      resumedAt: new Date().toISOString(),
      summary,
      recentActions: actions.slice(-10),
      keyDecisions,
      activeWorkflows: workflows,
      continuityGap: gap,
    };
  }

  /**
   * Get a summary of recent activity across all sessions
   */
  async getRecentActivitySummary(hoursBack: number = 24): Promise<{
    period: string;
    totalActions: number;
    sessions: string[];
    highlights: string[];
  }> {
    const since = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();
    
    const actions = await this.store.queryActions({
      since,
      limit: 1000,
    });

    const sessions = [...new Set(actions.map(a => a.sessionId).filter(Boolean))];
    
    // Extract highlights (important events)
    const highlights: string[] = [];
    const criticalActions = actions.filter(a => a.severity === "critical");
    
    for (const action of criticalActions.slice(-5)) {
      highlights.push(`${action.timestamp}: ${action.description}`);
    }

    // Add session transitions
    const sessionStarts = actions.filter(a => a.type === "session_start");
    for (const start of sessionStarts) {
      highlights.push(`Session started: ${start.sessionId}`);
    }

    return {
      period: `Last ${hoursBack} hours`,
      totalActions: actions.length,
      sessions,
      highlights,
    };
  }

  /**
   * Build a human-readable summary of a session
   */
  private buildSessionSummary(actions: StoredAction[], sessionId: string): string {
    if (actions.length === 0) {
      return `Session ${sessionId} had no recorded actions.`;
    }

    const startAction = actions[0];
    const endAction = actions[actions.length - 1];
    
    const startTime = new Date(startAction.timestamp);
    const endTime = new Date(endAction.timestamp);
    const duration = endTime.getTime() - startTime.getTime();
    
    // Count action types
    const typeCounts = new Map<string, number>();
    for (const action of actions) {
      const count = typeCounts.get(action.type) || 0;
      typeCounts.set(action.type, count + 1);
    }

    // Build summary
    const lines = [
      `Session ${sessionId.substring(0, 8)}...`,
      `Duration: ${this.formatDuration(duration)}`,
      `Total actions: ${actions.length}`,
      "Action breakdown:",
    ];

    for (const [type, count] of typeCounts.entries()) {
      lines.push(`  - ${type}: ${count}`);
    }

    // Add key events
    const criticalCount = actions.filter(a => a.severity === "critical").length;
    const highCount = actions.filter(a => a.severity === "high").length;
    
    if (criticalCount > 0 || highCount > 0) {
      lines.push(`Key events: ${criticalCount} critical, ${highCount} high severity`);
    }

    return lines.join("\n");
  }

  /**
   * Extract workflow information from actions
   */
  private extractWorkflows(actions: StoredAction[]): string[] {
    const workflows = new Set<string>();
    
    for (const action of actions) {
      // Look for workflow indicators in metadata
      if (action.metadata?.workflow) {
        workflows.add(String(action.metadata.workflow));
      }
      
      // Tool calls might indicate workflows
      if (action.toolName) {
        const workflowIndicator = this.inferWorkflowFromTool(action.toolName, action.description);
        if (workflowIndicator) {
          workflows.add(workflowIndicator);
        }
      }
    }

    return [...workflows];
  }

  /**
   * Try to infer workflow from tool usage
   */
  private inferWorkflowFromTool(toolName: string, description: string): string | null {
    const toolWorkflows: Record<string, string> = {
      "write": "file-operations",
      "edit": "file-operations",
      "exec": "command-execution",
      "browser": "web-browsing",
      "nodes": "device-management",
      "message": "messaging",
    };

    const normalizedTool = toolName.toLowerCase();
    
    for (const [pattern, workflow] of Object.entries(toolWorkflows)) {
      if (normalizedTool.includes(pattern)) {
        return workflow;
      }
    }

    return null;
  }

  /**
   * Calculate continuity gap since last action
   */
  private calculateContinuityGap(lastTimestamp: string): string | undefined {
    const lastTime = new Date(lastTimestamp).getTime();
    const now = Date.now();
    const gapMs = now - lastTime;
    
    if (gapMs < 60000) return undefined; // Less than 1 minute, no gap
    
    const minutes = Math.floor(gapMs / 60000);
    if (minutes < 60) return `${minutes} minutes`;
    
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} hours`;
    
    const days = Math.floor(hours / 24);
    return `${days} days`;
  }

  private formatDuration(ms: number): string {
    if (ms < 60000) return `${Math.floor(ms / 1000)}s`;
    if (ms < 3600000) return `${Math.floor(ms / 60000)}m`;
    return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`;
  }
}
