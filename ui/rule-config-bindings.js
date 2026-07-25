import { ruleProfileManager } from '../utils/config/RuleProfileManager.js';

let currentEditingId = null;

function createEmptyProfile() {
    return {
        id: '',
        name: '',
        tagExtractionEnabled: false,
        tags: '',
        exclusionRules: [],
        excludeUserMessages: false,
    };
}

function createRuleRow(rule = { start: '', end: '' }, index = 0) {
    return `
        <div class="amily2-rule-row am2-rule-row" data-index="${index}">
            <input type="text" class="text_pole amily2-rule-start" value="${escapeHtml(rule.start || '')}" placeholder="起始标记，如 &lt;think&gt;">
            <input type="text" class="text_pole amily2-rule-end" value="${escapeHtml(rule.end || '')}" placeholder="结束标记，如 &lt;/think&gt;">
            <button type="button" class="menu_button danger small_button amily2-rule-remove" title="删除这条">
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
        list.html('<div class="am2-empty-mini notes">还没有排除段落。<br>需要时点「添加」。</div>');
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
        excludeUserMessages: container.find('#amily2_rule_profile_exclude_user').is(':checked'),
    };
}

function renderProfileList(container) {
    const list = container.find('#amily2_rule_profile_list');
    const profiles = ruleProfileManager.listProfiles();

    if (!profiles.length) {
        list.html('<div class="am2-empty-mini notes">还没有规则。<br>点上方「新建」开始。</div>');
        return;
    }

    list.html(profiles.map(profile => {
        const active = profile.id === currentEditingId ? ' is-active' : '';
        const bits = [];
        if (profile.tagExtractionEnabled) bits.push('标签提取');
        if (profile.excludeUserMessages) bits.push('跳过用户');
        const n = (profile.exclusionRules || []).length;
        if (n) bits.push(`排除 ${n} 条`);
        const meta = bits.length ? bits.join(' · ') : '默认规则';
        return `
        <button type="button" class="am2-rule-item amily2-rule-profile-item${active}" data-id="${profile.id}">
            <span class="am2-rule-item-name">${escapeHtml(profile.name || profile.id)}</span>
            <span class="am2-rule-item-meta">${escapeHtml(meta)}</span>
        </button>`;
    }).join(''));
}

function fillEditor(container, profile) {
    const current = profile || createEmptyProfile();
    currentEditingId = current.id || null;
    container.find('#amily2_rule_profile_name').val(current.name || '');
    container.find('#amily2_rule_profile_tag_toggle').prop('checked', !!current.tagExtractionEnabled);
    container.find('#amily2_rule_profile_tags').val(current.tags || '');
    container.find('#amily2_rule_profile_tags_wrap').toggle(!!current.tagExtractionEnabled);
    container.find('#amily2_rule_profile_exclude_user').prop('checked', !!current.excludeUserMessages);
    renderRules(container, current.exclusionRules || []);

    const isNew = !current.id;
    container.find('#amily2_rule_editor_title').text(isNew ? '新建规则' : '编辑规则');
    container.find('#amily2_rule_editor_hint').text(
        isNew ? '填名称后点保存' : (current.name || current.id || '')
    );
    container.find('#amily2_rule_profile_delete').prop('disabled', isNew);
    renderProfileList(container);
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
            toastr.warning('请先填写规则名称。');
            return;
        }
        const saved = ruleProfileManager.saveProfile(profile);
        fillEditor($c, saved);

        toastr.success('规则已保存。');
    });

    $c.on('click.ruleConfig', '#amily2_rule_profile_delete', () => {
        if (!currentEditingId) {
            return;
        }
        if (!confirm('删除这条规则？用到它的功能会回退到默认。')) {
            return;
        }
        ruleProfileManager.deleteProfile(currentEditingId);
        fillEditor($c, createEmptyProfile());

        toastr.success('规则已删除。');
    });
}
