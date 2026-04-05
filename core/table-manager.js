
class TableManager {
    constructor() {
        console.log('TableManager initialized');
    }
    getTableData() {
        return {};
    }
    updateTableData(newData) {
        console.log('Updating table data with:', newData);
    }
}
export const tableManager = new TableManager();
