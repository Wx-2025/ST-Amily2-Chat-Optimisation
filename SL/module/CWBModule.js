import { Module, ModuleBuilder } from './Module.js';
import { initializeCharacterWorldBook } from '../../CharacterWorldBook/cwb_index.js';

const builder = new ModuleBuilder()
    .name('CharacterWorldBook')
    .view('CharacterWorldBook/cwb_settings.html')
    .strict(true)
    .required(['mount']);

export default class CWBModule extends Module {
    constructor() {
        super(builder);
    }

    async mount() {
        if (this.el) {
            this.el.id = 'amily2_character_world_book_panel';
            this.el.style.display = 'none';
        }
        await initializeCharacterWorldBook($(this.el));
    }
}
