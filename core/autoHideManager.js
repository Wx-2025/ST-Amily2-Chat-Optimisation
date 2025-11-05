import { getContext, extension_settings } from "/scripts/extensions.js";
import { SlashCommandParser } from "/scripts/slash-commands/SlashCommandParser.js";
import { extensionName } from "../utils/settings.js";
import { readGoldenLedgerProgress } from "./historiographer.js";
import { characters } from "/script.js";
import { getChatIdentifier } from "./lore.js";


async function executeSlashCommand(commandString) {
    if (!commandString) return;
    try {
        console.log(`[Amily-敕令执行官] 准备执行圣谕: ${commandString}`);
        const parser = new SlashCommandParser();
        const closure = parser.parse(commandString, false);

        if (closure && typeof closure.execute === 'function') {
            await closure.execute();
            console.log(`[Amily-敕令执行官] 圣谕: "${commandString}" 已成功颁布。`);
            toastr.success(`圣谕 "${commandString}" 已成功颁布`, "敕令司回报");
        } else {
            const errorMsg = `铸造出的圣谕法印无法执行！指令: ${commandString}`;
            console.error(`[Amily-敕令执行官] ${errorMsg}`);
            toastr.error(errorMsg, "敕令司紧急报告");
        }
    } catch (error) {
        console.error(`[Amily-敕令执行官] 执行圣谕 "${commandString}" 时发生意外:`, error);
        toastr.error(`执行圣谕时发生意外: ${error.message}`, "敕令司紧急报告");
    }
}

export async function executeAutoHide() {
    try {
        const settings = extension_settings[extensionName];
        const context = getContext();
        const chatLength = context.chat.length;
        let hideUntilIndex = -1;

        if (settings.autoHideSummarizedEnabled) {
            let targetLorebookName;
            switch (settings.lorebookTarget) {
                case "character_main":
                    targetLorebookName = characters[context.characterId]?.data?.extensions?.world;
                    break;
                case "dedicated":
                    const chatIdentifier = await getChatIdentifier();
                    targetLorebookName = `Amily2-Lore-${chatIdentifier}`;
                    break;
            }

            if (targetLorebookName) {
                const summarizedCount = await readGoldenLedgerProgress(targetLorebookName);
                if (summarizedCount > 0) {
                    hideUntilIndex = summarizedCount - 1;
                }
            }
        }

        if (settings.autoHideEnabled) {
            const threshold = settings.autoHideThreshold || 30;
            const thresholdHideIndex = chatLength - threshold - 1;
            if (thresholdHideIndex > hideUntilIndex) {
                hideUntilIndex = thresholdHideIndex;
            }
        }

        if (hideUntilIndex < 0) {
            return;
        }

        const commandString = `/hide 0-${hideUntilIndex}`;
        console.log(`[Amily-史册管理员] 颁布圣谕: ${commandString}`);
        const parser = new SlashCommandParser();
        const closure = parser.parse(commandString, false);

        if (closure && typeof closure.execute === 'function') {
            await closure.execute();
            console.log(`[Amily-史册管理员] 圣谕颁布成功。`);
        } else {
            console.error('[Amily-史册管理员] 致命错误：铸造出的圣谕法印无法执行！');
        }

    } catch (error) {
        console.error('[Amily-史册管理员] 执行自动隐藏律法时发生意外错误:', error);
    }
}

export async function executeManualCommand(commandType, params = {}) {
    const { from, to } = params;

    let commandString = '';

    switch (commandType) {
        case 'unhide_all': {
            const chatLength = getContext().chat.length;
            if (chatLength > 0) {
                const lastIndex = chatLength - 1;
                commandString = `/unhide 0-${lastIndex}`;
            } else {
                toastr.info("史册为空，无需解除隐藏。", "敕令司回报");
                return; 
            }
            break;
        }

        case 'manual_hide':
        case 'manual_unhide': {
            const command = commandType === 'manual_hide' ? '/hide' : '/unhide';
            if (from === '' && to !== '') {
                commandString = `${command} ${to}`;
            } else if (from !== '' && to !== '') {
                if (parseInt(from) > parseInt(to)) {
                    toastr.warning("起始层不能大于结束层", "敕令司提示");
                    return;
                }
                commandString = `${command} ${from}-${to}`;
            } else {
                toastr.warning("请输入有效的楼层范围", "敕令司提示");
                return;
            }
            break;
        }

        default:
            console.error(`[Amily-手动敕令司] 未知的命令类型: ${commandType}`);
            return;
    }

    await executeSlashCommand(commandString);
}
