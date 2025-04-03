import { ElizaService } from "./eliza.service.js";
import { MineflayerService } from "./mineflayer.service.js";
import { BaseService } from "./base.service.js";
import {
  Content,
  Memory,
  ModelClass,
  UUID,
  stringToUuid,
  composeContext,
  generateMessageResponse,
  generateShouldRespond,
  getEmbeddingZeroVector,
  messageCompletionFooter,
  shouldRespondFooter,
  elizaLogger,
} from "@ai16z/eliza";
import { Bot } from "grammy";
import { Context } from "grammy";
import fs from "fs";
import path from "path";
import { resolve } from "path";
import { Message } from "grammy/types";

// Define interfaces for typed data
interface MinecraftContext {
  playerUsername: string;
  playerPosition?: { x: number; y: number; z: number };
  botUsername?: string;
  botPosition?: { x: number; y: number; z: number };
  botHealth?: number;
  botFood?: number;
  gameMode?: string;
  inventory?: Array<{ name: string; count: number }>;
  nearbyPlayers?: string[];
}

interface PendingAction {
  action: string;
  parameters: Record<string, any>;
}

interface MessageHistoryEntry {
  sender: string;
  message: string;
  timestamp: number;
}

interface MessageHistoryMap {
  [username: string]: MessageHistoryEntry[];
}

// Minecraft-specific message templates
const minecraftShouldRespondTemplate =
  `
# About {{agentName}}:
{{bio}}

# RESPONSE EXAMPLES
Player1: hey
Result: [IGNORE]

Player1: @{{agentName}} can you help me build a house?
Result: [RESPOND]

Player1: {{agentName}} follow me
Result: [RESPOND]

Player1: @{{agentName}} stop following me
Result: [RESPOND]

Player1: where is everyone?
Result: [IGNORE]

Player1: @{{agentName}} chop down some trees and get 64 logs
Result: [RESPOND]

Player1: nice job {{agentName}}
Result: [RESPOND]

Player1: that was terrible {{agentName}}
Result: [RESPOND]

Player1: shut up {{agentName}}
Result: [STOP]

Player1: {{agentName}} please be quiet
Result: [STOP]

Player1: can someone help me mine?
Result: [IGNORE]

Response options are [RESPOND], [IGNORE] and [STOP].

{{agentName}} is in a Minecraft world with other players and should only respond when directly addressed or when the conversation is clearly relevant to them.

Respond with [RESPOND] to messages that:
- Contain the bot's name ({{agentName}})
- Directly address the bot with @ symbol (@{{agentName}})
- Ask for help with tasks the bot can perform (building, harvesting, following, etc.)
- Continue a conversation where the bot was just participating

Respond with [IGNORE] to messages that:
- Are very short or vague
- Do not mention the bot
- Are clearly directed at other players
- Ask for things the bot cannot do

Respond with [STOP] if:
- A player asks the bot to be quiet or stop talking
- The conversation with the bot has naturally concluded

The goal is to decide whether {{agentName}} should respond to the last message.

# Current Minecraft Context
{{minecraftContext}}

# Recent Messages
{{recentMessages}}

# INSTRUCTIONS: Choose the option that best describes {{agentName}}'s response to the last message.
` + shouldRespondFooter;

const minecraftMessageHandlerTemplate =
  `
# Action Names
HARVEST_TREES, BUILD_PLATFORM, FOLLOW_PLAYER, STOP_FOLLOWING, COME_TO_PLAYER, THROW_ITEMS, MINT_TOKEN, GET_ACCOUNTS, TRANSFER_ETH, TRANSFER_ERC20, SPEAK

# Action Examples
{
  "action": "HARVEST_TREES", 
  "parameters": {
    "username": "player1", 
    "amount": 64
  }
}

{
  "action": "BUILD_PLATFORM", 
  "parameters": {
    "username": "player1", 
    "size": 5
  }
}

{
  "action": "SPEAK", 
  "parameters": {
    "message": "I'll help you with that!"
  }
}

# Task: Generate dialog and actions for the character {{agentName}}.
About {{agentName}}:
{{bio}}
{{lore}}

Examples of {{agentName}}'s dialog and actions:
{{messageExamples}}

# Capabilities
{{agentName}} is a Minecraft bot that can:
1. Harvest trees and collect logs (!harvest command)
2. Build platforms (!platform command)
3. Follow players (!follow command)
4. Stop following players (!stopfollow command)
5. Come to players (!come command)
6. Throw items to players (!throw command)
7. Mint tokens (!mint command)
8. Get account information (!accounts command)
9. Transfer ETH (!sendeth command)
10. Transfer ERC20 tokens (!senderc20 command)

# Current Minecraft Context
{{minecraftContext}}

# Recent Messages:
{{recentMessages}}

# Task: Generate a response in the voice, style and perspective of {{agentName}} to the player's message.
Include appropriate actions when the player requests the bot to perform a task.
` + messageCompletionFooter;

export class MinecraftAgentService extends BaseService {
  private static instance: MinecraftAgentService;
  private elizaService: ElizaService;
  private mineflayerService: MineflayerService;
  private mockBot: Bot<Context>; // Mock bot for Eliza compatibility
  private messageHistory: MessageHistoryMap = {};
  private pendingActions: PendingAction[] = [];
  private actionIntervalId: NodeJS.Timeout | null = null;

  private constructor() {
    super();
    this.mineflayerService = MineflayerService.getInstance();
    this.setupMockBot();
  }

  public static getInstance(): MinecraftAgentService {
    if (!MinecraftAgentService.instance) {
      MinecraftAgentService.instance = new MinecraftAgentService();
    }
    return MinecraftAgentService.instance;
  }

  private setupMockBot(): void {
    // Create a minimal mock of the Telegram bot API for Eliza
    this.mockBot = {
      botInfo: {
        id: 1,
        is_bot: true,
        first_name: "MinecraftAgent",
        username: "minecraft_agent",
        can_join_groups: true,
        can_read_all_group_messages: true,
        supports_inline_queries: false,
      },
      api: {
        getMe: async () => this.mockBot.botInfo,
        sendMessage: async (
          chatId: number | string,
          text: string,
        ): Promise<Message.TextMessage> => {
          // We'll intercept these messages and send them to Minecraft instead
          const minecraftBot = this.mineflayerService.getBot();
          if (minecraftBot) {
            minecraftBot.chat(text);
          }
          // Return a mock message object
          return {
            message_id: Date.now(),
            from: this.mockBot.botInfo,
            chat: {
              id: Number(chatId),
              type: "group",
              title: "Minecraft World",
            },
            date: Math.floor(Date.now() / 1000),
            text: text,
          } as Message.TextMessage;
        },
        getFile: async () => ({ file_path: "" }),
        setWebhook: async () => true,
        deleteWebhook: async () => true,
      },
    } as unknown as Bot<Context>;

    // Initialize Eliza with our mock bot
    this.elizaService = ElizaService.getInstance(this.mockBot);
  }

  async loadMinecraftCharacter(): Promise<void> {
    // Try to load a Minecraft-specific character, or create one
    const __dirname = path.dirname(new URL(import.meta.url).pathname);
    const characterPath = resolve(
      __dirname,
      "../../..",
      "minecraft-character.json"
    );

    let character;
    try {
      if (fs.existsSync(characterPath)) {
        const data = fs.readFileSync(characterPath, "utf8");
        character = JSON.parse(data);
        elizaLogger.info("Loaded Minecraft character from:", characterPath);
      } else {
        // Create default Minecraft character
        character = {
          name: "MinecraftAgent",
          bio: "I am a helpful Minecraft bot that can assist with building, resource gathering, and navigating the world.",
          lore: "I've explored countless Minecraft worlds and mastered the art of survival and creation. I can build structures, harvest resources, and help players in their adventures.",
          modelProvider: process.env.MODEL_PROVIDER || "OPENAI",
          clientConfig: {
            telegram: {
              shouldIgnoreBotMessages: false,
              shouldIgnoreDirectMessages: false,
            },
          },
          templates: {
            telegramShouldRespondTemplate: minecraftShouldRespondTemplate,
            telegramMessageHandlerTemplate: minecraftMessageHandlerTemplate,
            shouldRespondTemplate: minecraftShouldRespondTemplate,
            messageHandlerTemplate: minecraftMessageHandlerTemplate,
          },
        };

        // Save the character for future use
        fs.writeFileSync(characterPath, JSON.stringify(character, null, 2));
        elizaLogger.info(
          "Created default Minecraft character at:",
          characterPath
        );
      }

      // Update the runtime with our character
      const runtime = this.elizaService.getRuntime();
      runtime.character = character;

      elizaLogger.info("Minecraft character configured:", character.name);
    } catch (error) {
      console.error("Error loading Minecraft character:", error);
      throw error;
    }
  }

  async start(): Promise<void> {
    try {
      // Start the Mineflayer service first
      await this.mineflayerService.start();

      // Configure Eliza with Minecraft-specific character
      await this.loadMinecraftCharacter();

      // Start Eliza service
      await this.elizaService.start();

      // Set up the integration between services
      this.setupIntegration();

      console.log("[MinecraftAgent] Service started successfully");
    } catch (error) {
      console.error("[MinecraftAgent] Failed to start service:", error);
      throw error;
    }
  }

  private setupIntegration(): void {
    const bot = this.mineflayerService.getBot();
    if (!bot) {
      console.error("[MinecraftAgent] No Minecraft bot available");
      return;
    }

    // Handle Minecraft chat messages
    bot.on("chat", async (username: string, message: string) => {
      if (username === bot.username) return; // Ignore own messages

      // Track conversation by username
      if (!this.messageHistory[username]) {
        this.messageHistory[username] = [];
      }
      this.messageHistory[username].push({
        sender: username,
        message,
        timestamp: Date.now(),
      });

      // Only keep last 10 messages per user
      if (this.messageHistory[username].length > 10) {
        this.messageHistory[username].shift();
      }

      // Handle commands
      const botUsername = bot.username || "MinecraftAgent";
      const lowerMessage = message.toLowerCase();

      // Check if message addresses the bot directly or is a command
      const isBotMention =
        lowerMessage.includes(`@${botUsername.toLowerCase()}`) ||
        lowerMessage.startsWith(botUsername.toLowerCase());
      const isCommand =
        lowerMessage.includes("!harvest") ||
        lowerMessage.includes("!platform") ||
        lowerMessage.includes("!follow") ||
        lowerMessage.includes("!come") ||
        lowerMessage.includes("!throw") ||
        lowerMessage.includes("!mint") ||
        lowerMessage.includes("!accounts") ||
        lowerMessage.includes("!sendeth") ||
        lowerMessage.includes("!senderc20");

      // If it's a direct command, let MineflayerService handle it
      if (isBotMention && isCommand) {
        // MineflayerService will handle this through its own chat handler
        console.log(
          "[MinecraftAgent] Command detected, letting MineflayerService handle it."
        );
        return;
      }

      // For everything else, let's use Eliza to determine if we should respond
      await this.handleNaturalLanguage(username, message);
    });

    // Handle additional Minecraft events for context
    bot.on("playerJoined", (player) => {
      this.storeMinecraftEvent("playerJoined", {
        username: player.username,
        timestamp: Date.now(),
      });
    });

    bot.on("playerLeft", (player) => {
      this.storeMinecraftEvent("playerLeft", {
        username: player.username,
        timestamp: Date.now(),
      });
    });

    bot.on("death", () => {
      if (bot.entity?.position) {
        this.storeMinecraftEvent("botDeath", {
          position: bot.entity.position,
          timestamp: Date.now(),
        });
      }
    });

    // Execute pending actions periodically
    this.actionIntervalId = setInterval(
      this.processPendingActions.bind(this),
      1000
    );
  }

  private async processPendingActions(): Promise<void> {
    if (this.pendingActions.length === 0) return;

    const action = this.pendingActions.shift();
    if (action) {
      await this.executeAction(action.action, action.parameters);
    }
  }

  private async executeAction(
    action: string,
    parameters: Record<string, any>
  ): Promise<void> {
    try {
      const bot = this.mineflayerService.getBot();
      if (!bot) return;

      console.log(`[MinecraftAgent] Executing action: ${action}`, parameters);

      switch (action) {
        case "HARVEST_TREES":
          await this.mineflayerService.harvestTree(
            parameters.username,
            parseInt(parameters.amount)
          );
          break;

        case "BUILD_PLATFORM":
          await this.mineflayerService.buildPlatform(
            parameters.username,
            parseInt(parameters.size)
          );
          break;

        case "FOLLOW_PLAYER":
          // Direct method call
          await this.mineflayerService
            .getBot()
            ?.chat(`@${this.mineflayerService.getBot()?.username} !follow`);
          break;

        case "STOP_FOLLOWING":
          await this.mineflayerService
            .getBot()
            ?.chat(`@${this.mineflayerService.getBot()?.username} !stopfollow`);
          break;

        case "COME_TO_PLAYER":
          await this.mineflayerService
            .getBot()
            ?.chat(`@${this.mineflayerService.getBot()?.username} !come`);
          break;

        case "THROW_ITEMS":
          await this.mineflayerService
            .getBot()
            ?.chat(`@${this.mineflayerService.getBot()?.username} !throw`);
          break;

        case "MINT_TOKEN":
          await this.mineflayerService
            .getBot()
            ?.chat(`@${this.mineflayerService.getBot()?.username} !mint`);
          break;

        case "GET_ACCOUNTS":
          await this.mineflayerService
            .getBot()
            ?.chat(`@${this.mineflayerService.getBot()?.username} !accounts`);
          break;

        case "TRANSFER_ETH":
          const ethCommand = parameters.receiver
            ? `@${this.mineflayerService.getBot()?.username} !sendeth ${parameters.receiver}`
            : `@${this.mineflayerService.getBot()?.username} !sendeth`;
          await this.mineflayerService.getBot()?.chat(ethCommand);
          break;

        case "TRANSFER_ERC20":
          const erc20Command = `@${this.mineflayerService.getBot()?.username} !senderc20 ${parameters.token} ${parameters.recipient} ${parameters.amount}`;
          await this.mineflayerService.getBot()?.chat(erc20Command);
          break;

        case "SPEAK":
          await bot.chat(parameters.message);
          break;

        default:
          console.log(`[MinecraftAgent] Unknown action: ${action}`);
      }
    } catch (error) {
      console.error(
        `[MinecraftAgent] Error executing action ${action}:`,
        error
      );
    }
  }

  async handleNaturalLanguage(
    username: string,
    message: string
  ): Promise<void> {
    try {
      const bot = this.mineflayerService.getBot();
      if (!bot) return;

      // Create a unique user ID for this player
      const userId = stringToUuid(username) as UUID;
      const roomId = stringToUuid("minecraft_world") as UUID;
      const agentId = this.elizaService.getRuntime().agentId;

      // Ensure connection
      await this.elizaService
        .getRuntime()
        .ensureConnection(userId, roomId, username, username, "minecraft");

      // Create a unique message ID
      const messageId = stringToUuid(
        `${Date.now()}-${username}-${message.substring(0, 10)}`
      ) as UUID;

      // Gather Minecraft context
      const minecraftContext: MinecraftContext = {
        playerUsername: username,
        playerPosition: bot.players[username]?.entity?.position,
        botUsername: bot.username,
        botPosition: bot.entity?.position,
        botHealth: bot.health,
        botFood: bot.food,
        gameMode: bot.game?.gameMode,
        inventory: bot.inventory
          ?.items()
          .map((item) => ({ name: item.name, count: item.count })),
        nearbyPlayers: Object.keys(bot.players).filter(
          (name) =>
            bot.players[name]?.entity &&
            bot.entity?.position &&
            bot.entity.position.distanceTo(bot.players[name].entity.position) <
              30
        ),
      };

      // Create memory for this message
      const content: Content = {
        text: message,
        source: "minecraft",
        minecraftContext: JSON.stringify(minecraftContext),
      };

      const memory: Memory = {
        id: messageId,
        agentId,
        userId,
        roomId,
        content,
        createdAt: Date.now(),
        embedding: getEmbeddingZeroVector(),
      };

      // Add embedding and store in memory
      const memoryWithEmbedding = await this.elizaService
        .getRuntime()
        .messageManager.addEmbeddingToMemory(memory);
      await this.elizaService
        .getRuntime()
        .messageManager.createMemory(memoryWithEmbedding, true);

      // Build state from memory
      let state = await this.elizaService
        .getRuntime()
        .composeState(memoryWithEmbedding);
      state = await this.elizaService
        .getRuntime()
        .updateRecentMessageState(state);

      // Add Minecraft-specific context to the state
      state.minecraftContext = JSON.stringify(minecraftContext, null, 2);

      // Format recent messages for context
      const recentMessages = this.messageHistory[username] || [];
      state.recentMessages = recentMessages
        .map((msg) => `${msg.sender}: ${msg.message}`)
        .join("\n");

      // Check if the agent should respond
      const shouldRespondContext = composeContext({
        state,
        template: minecraftShouldRespondTemplate,
      });

      // Using the correct way to determine if we should respond - using the public API
      const shouldRespondResult = await generateShouldRespond({
        runtime: this.elizaService.getRuntime(),
        context: shouldRespondContext,
        modelClass: ModelClass.MEDIUM,
      });

      // The result will be "RESPOND", "IGNORE", or "STOP"
      const shouldRespond = shouldRespondResult === "RESPOND";
      console.log(
        `[MinecraftAgent] Should respond to "${message}"? ${shouldRespond}`
      );

      if (shouldRespond) {
        // Generate a response
        const responseContext = composeContext({
          state,
          template: minecraftMessageHandlerTemplate,
        });

        const response = await generateMessageResponse({
          runtime: this.elizaService.getRuntime(),
          context: responseContext,
          modelClass: ModelClass.MEDIUM,
        });

        if (!response) {
          console.error("[MinecraftAgent] No response generated");
          return;
        }

        // Send the text response
        if (response.text) {
          bot.chat(response.text);
        }

        // Store the response in memory
        const responseMemory: Memory = {
          id: stringToUuid(`response-${Date.now()}`) as UUID,
          agentId,
          userId,
          roomId,
          content: response,
          createdAt: Date.now(),
          embedding: getEmbeddingZeroVector(),
        };
        await this.elizaService
          .getRuntime()
          .messageManager.createMemory(responseMemory);

        // Process any actions
        if (response.action) {
          this.pendingActions.push({
            action: response.action,
            parameters: response.parameters || {},
          });
        }

        // Update state after response
        state = await this.elizaService
          .getRuntime()
          .updateRecentMessageState(state);
      }
    } catch (error) {
      console.error("[MinecraftAgent] Error handling natural language:", error);
    }
  }

  private async storeMinecraftEvent(type: string, data: any): Promise<void> {
    try {
      const roomId = stringToUuid("minecraft_world") as UUID;
      const agentId = this.elizaService.getRuntime().agentId;

      const memory: Memory = {
        id: stringToUuid(`event-${Date.now()}-${type}`) as UUID,
        agentId,
        userId: stringToUuid("system") as UUID,
        roomId,
        content: {
          text: `[Minecraft Event] ${type}: ${JSON.stringify(data)}`,
          source: "minecraft_event",
          event: { type, data },
        },
        createdAt: Date.now(),
        embedding: getEmbeddingZeroVector(),
      };

      const memoryWithEmbedding = await this.elizaService
        .getRuntime()
        .messageManager.addEmbeddingToMemory(memory);
      await this.elizaService
        .getRuntime()
        .messageManager.createMemory(memoryWithEmbedding);

      console.log(`[MinecraftAgent] Stored event: ${type}`);
    } catch (error) {
      console.error("[MinecraftAgent] Error storing Minecraft event:", error);
    }
  }

  async stop(): Promise<void> {
    try {
      // Clear interval
      if (this.actionIntervalId) {
        clearInterval(this.actionIntervalId);
        this.actionIntervalId = null;
      }

      // Clean shutdown
      await this.elizaService.stop();
      await this.mineflayerService.stop();
      console.log("[MinecraftAgent] Service stopped");
    } catch (error) {
      console.error("[MinecraftAgent] Error stopping service:", error);
    }
  }
}
