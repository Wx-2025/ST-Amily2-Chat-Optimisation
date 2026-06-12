/**
 * ui/profile-slider-guard.js — profile 压制提示（T-006）
 *
 * v2.2.0 起 profile 一旦分配即权威：模块面板上的温度 / maxTokens 等参数控件
 * 不再影响请求，但控件本身仍可操作——用户改了没效果，是个陷阱。
 *
 * 本模块提供统一的"informational 化"处理：
 *   - slot 已分配 profile → 控件 disable + 半透明，旁边插入提示行
 *     "当前由连接配置「xxx」控制，请在 API 连接配置面板修改"
 *   - 未分配 → 恢复可用、移除提示（legacy 字段路径仍然生效）
 *
 * 用法（各面板绑定初始化时调用一次）：
 *   watchProfileSliderGuard('cwb', ['#cwb-temperature', '#cwb-max-tokens']);
 *
 * 刷新时机：立即执行一次 + 监听 ApiProfileManager.setAssignment 派发的
 * 'amily2-profile-assignment-changed' 事件（只响应本 slot 的变更）。
 * 面板内容是惰性挂载的，apply 对找不到的元素静默跳过，可安全重复调用。
 */

import { apiProfileManager } from '../utils/config/ApiProfileManager.js';
import { escapeHTML } from '../utils/utils.js';

const HINT_CLASS = 'amily2-profile-guard-hint';

/**
 * 按当前分配状态套用/解除压制提示。无状态，可重复调用。
 * @param {string} slot       - ApiProfileManager.SLOTS 中的功能槽名
 * @param {string[]} selectors - 受 profile 压制的输入控件选择器列表
 */
export function applyProfileSliderGuard(slot, selectors) {
    const $els = $(selectors.join(', '));
    if ($els.length === 0) return; // 面板尚未挂载

    const profileId = apiProfileManager.getAssignment(slot);
    const profile = profileId ? apiProfileManager.getProfile(profileId) : null;

    // 提示行挂在第一个控件所属的块级容器之后；先清旧的再按需重建，避免重复
    const $anchor = $els.first().closest('div, label');
    $anchor.parent().find(`.${HINT_CLASS}`).remove();

    if (profile) {
        $els.prop('disabled', true).css('opacity', '0.5');
        $anchor.after(
            `<div class="${HINT_CLASS}" style="font-size: 0.85em; opacity: 0.75; margin: 4px 0;">` +
            `<i class="fa-solid fa-lock" style="margin-right: 4px;"></i>` +
            `以上参数当前由连接配置「${escapeHTML(profile.name || profileId)}」控制，请在 API 连接配置面板修改。` +
            `</div>`
        );
    } else {
        $els.prop('disabled', false).css('opacity', '');
    }
}

/**
 * applyProfileSliderGuard + 订阅分配变更事件。各面板初始化时调用一次。
 */
export function watchProfileSliderGuard(slot, selectors) {
    applyProfileSliderGuard(slot, selectors);
    document.addEventListener('amily2-profile-assignment-changed', (e) => {
        if (e.detail?.slot === slot) applyProfileSliderGuard(slot, selectors);
    });
}
