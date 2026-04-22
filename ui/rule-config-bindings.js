import { ruleProfileManager } from '../utils/config/RuleProfileManager.js';

let currentEditingId = null;

function createEmptyProfile() {
    return {
        id: '',
        name: '',
        tagExtractionEnabled: false,
        tags: '',
        exclusionRules: [],
    };
}

function createRuleRow(rule = { start: '', end: '' }, index = 0) {
    return `
        <div class="amily2-rule-row" data-index="${index}">
            <input type="text" class="text_pole amily2-rule-start" value="${escapeHtml(rule.start || '')}" placeholder="起始标记">
            <input type="text" class="text_pole amily2-rule-end" value="${escapeHtml(rule.end || '')}" placeholder="结束标记">
            <button type="button" class="menu_button danger small_button amily2-rule-remove">
                <i class="fas fa-trash-alt"></i>
            </button>
        </div>
    `;
}

function escapeHtml(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function renderRules(container, exclusionRules = []) {
    const list = container.find('#amily2_rule_profile_rules');
    if (!exclusionRules.length) {
        list.html('<p class="notes">当前没有排除规则。</p>');
        return;
    }
    list.html(exclusionRules.map((rule, index) => createRuleRow(rule, index)).join(''));
}

function collectProfile(container) {
    const exclusionRules = [];
    container.find('.amily2-rule-row').each(function () {
        const start = $(this).find('.amily2-rule-start').val().trim();
        const end = $(this).find('.amily2-rule-end').val().trim();
        if (start) {
            exclusionRules.push({ start, end });
        }
    });

    return {
        id: currentEditingId || '',
        name: container.find('#amily2_rule_profile_name').val().trim(),
        tagExtractionEnabled: container.find('#amily2_rule_profile_tag_toggle').is(':checked'),
        tags: container.find('#amily2_rule_profile_tags').val(),
        exclusionRules,
    };
}

function renderProfileList(container) {
    const list = container.find('#amily2_rule_profile_list');
    const profiles = ruleProfileManager.listProfiles();

    if (!profiles.length) {
        list.html('<p class="notes">还没有规则配置。</p>');
        return;
    }

    list.html(profiles.map(profile => `
        <button type="button" class="menu_button wide_button amily2-rule-profile-item" data-id="${profile.id}">
            <span>${escapeHtml(profile.name || profile.id)}</span>
        </button>
    `).join(''));
}

function fillEditor(container, profile) {
    const current = profile || createEmptyProfile();
    currentEditingId = current.id || null;
    container.find('#amily2_rule_profile_name').val(current.name || '');
    container.find('#amily2_rule_profile_tag_toggle').prop('checked', !!current.tagExtractionEnabled);
    container.find('#amily2_rule_profile_tags').val(current.tags || '');
    container.find('#amily2_rule_profile_tags_wrap').toggle(!!current.tagExtractionEnabled);
    renderRules(container, current.exclusionRules || []);
}

export function bindRuleConfigPanel(container) {
    const $c = $(container);

    renderProfileList($c);
    fillEditor($c, createEmptyProfile());

    $c.off('.ruleConfig');

    $c.on('click.ruleConfig', '#amily2_rule_profile_new', () => {
        fillEditor($c, createEmptyProfile());
    });

    $c.on('click.ruleConfig', '.amily2-rule-profile-item', function () {
        const profile = ruleProfileManager.getProfile($(this).data('id'));
        if (profile) {
            fillEditor($c, profile);
        }
    });

    $c.on('change.ruleConfig', '#amily2_rule_profile_tag_toggle', function () {
        $c.find('#amily2_rule_profile_tags_wrap').toggle(this.checked);
    });

    $c.on('click.ruleConfig', '#amily2_rule_profile_add_rule', () => {
        const rules = collectProfile($c).exclusionRules;
        rules.push({ start: '', end: '' });
        renderRules($c, rules);
    });

    $c.on('click.ruleConfig', '.amily2-rule-remove', function () {
        $(this).closest('.amily2-rule-row').remove();
        if ($c.find('.amily2-rule-row').length === 0) {
            renderRules($c, []);
        }
    });

    $c.on('click.ruleConfig', '#amily2_rule_profile_save', () => {
        const profile = collectProfile($c);
        if (!profile.name) {
            toastr.warning('请先填写规则配置名称。');
            return;
        }
        const saved = ruleProfileManager.saveProfile(profile);
        fillEditor($c, saved);
        renderProfileList($c);

        toastr.success('规则配置已保存。');
    });

    $c.on('click.ruleConfig', '#amily2_rule_profile_delete', () => {
        if (!currentEditingId) {
            return;
        }
        if (!confirm('删除当前规则配置？引用它的位置会回退到旧配置。')) {
            return;
        }
        ruleProfileManager.deleteProfile(currentEditingId);
        fillEditor($c, createEmptyProfile());
        renderProfileList($c);

        toastr.success('规则配置已删除。');
    });
}
