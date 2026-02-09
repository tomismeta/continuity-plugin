/**
 * Integrity Validator - Cryptographic hash chain verification
 * 
 * Provides tamper detection for the action stream through:
 * - SHA-256 hash chaining between consecutive actions
 * - Full stream validation
 * - Corruption detection and reporting
 */

import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { PluginLogger } from "../../../plugins/types.js";
import type { StoredAction } from "./store.js";

export interface IntegrityReport {
  valid: boolean;
  totalChecked: number;
  errors: IntegrityError[];
  firstAction?: string;
  lastAction?: string;
}

export interface IntegrityError {
  sequence: number;
  type: "hash_mismatch" | "chain_break" | "invalid_json" | "missing_integrity";
  details: string;
}

export class IntegrityValidator {
  constructor(
    private readonly storagePath: string,
    private readonly logger: PluginLogger
  ) {}

  /**
   * Validate the integrity of a single action
   */
  validateAction(action: StoredAction, previousHash: string | null): IntegrityError | null {
    if (!action._integrity) {
      // Legacy action without integrity - not an error, just no verification possible
      return null;
    }

    // Check chain continuity
    const expectedPrevious = previousHash || "genesis";
    if (action._integrity.previous !== expectedPrevious) {
      return {
        sequence: action.sequence,
        type: "chain_break",
        details: `Expected previous hash ${expectedPrevious}, found ${action._integrity.previous}`,
      };
    }

    // Verify hash
    const { _integrity, ...actionWithoutIntegrity } = action;
    const calculatedHash = this.calculateHash(actionWithoutIntegrity, action._integrity.previous);
    
    if (calculatedHash !== action._integrity.hash) {
      return {
        sequence: action.sequence,
        type: "hash_mismatch",
        details: `Hash mismatch: calculated ${calculatedHash}, stored ${action._integrity.hash}`,
      };
    }

    return null;
  }

  /**
   * Validate the entire action stream
   */
  async validateStream(): Promise<IntegrityReport> {
    const errors: IntegrityError[] = [];
    let totalChecked = 0;
    let previousHash: string | null = null;
    let firstAction: string | undefined;
    let lastAction: string | undefined;

    const files = await this.getStreamFiles();
    
    for (const file of files) {
      try {
        const content = await fs.readFile(file, "utf-8");
        const lines = content.split("\n").filter(line => line.trim());
        
        for (const line of lines) {
          // Skip header lines
          if (line.includes('"_header":true')) {
            continue;
          }

          try {
            const action = JSON.parse(line) as StoredAction;
            totalChecked++;

            if (!firstAction) {
              firstAction = action.id;
            }
            lastAction = action.id;

            const error = this.validateAction(action, previousHash);
            if (error) {
              errors.push(error);
            }

            if (action._integrity) {
              previousHash = action._integrity.hash;
            }
          } catch (parseError) {
            errors.push({
              sequence: totalChecked + 1,
              type: "invalid_json",
              details: `Failed to parse: ${parseError}`,
            });
          }
        }
      } catch (readError) {
        errors.push({
          sequence: -1,
          type: "invalid_json",
          details: `Failed to read file ${path.basename(file)}: ${readError}`,
        });
      }
    }

    return {
      valid: errors.length === 0,
      totalChecked,
      errors,
      firstAction,
      lastAction,
    };
  }

  /**
   * Get the last valid hash from the stream
   */
  async getLastHash(): Promise<string | null> {
    const files = await this.getStreamFiles();
    
    // Check from newest to oldest
    for (let i = files.length - 1; i >= 0; i--) {
      try {
        const content = await fs.readFile(files[i], "utf-8");
        const lines = content.split("\n").filter(line => line.trim());
        
        // Check from end
        for (let j = lines.length - 1; j >= 0; j--) {
          try {
            const action = JSON.parse(lines[j]) as StoredAction;
            if (action._integrity?.hash) {
              return action._integrity.hash;
            }
          } catch {
            // Skip invalid lines
          }
        }
      } catch {
        // Skip unreadable files
      }
    }

    return null;
  }

  /**
   * Repair the integrity chain from a given point
   * Note: This creates a new "genesis" point - use only for recovery
   */
  async repairChain(fromSequence: number): Promise<boolean> {
    this.logger.warn(`[integrity] Attempting chain repair from sequence ${fromSequence}`);
    
    // This is a placeholder for repair logic
    // In a real implementation, this might:
    // 1. Mark the break point
    // 2. Start a new chain from the next valid action
    // 3. Log the repair event
    
    return true;
  }

  private calculateHash(action: Omit<StoredAction, "_integrity">, previous: string): string {
    const content = JSON.stringify(action) + previous;
    return createHash("sha256").update(content).digest("hex");
  }

  private async getStreamFiles(): Promise<string[]> {
    const files: string[] = [];
    
    try {
      const entries = await fs.readdir(this.storagePath);
      for (const entry of entries) {
        if (entry.startsWith("action-stream-") && entry.endsWith(".jsonl")) {
          files.push(path.join(this.storagePath, entry));
        }
      }
      files.sort(); // Oldest first
    } catch {
      // Ignore errors
    }

    return files;
  }
}
