const fs = require('fs');
const path = require('path');

// relative path ব্যবহার
const jsonPath = path.join(__dirname, 'serviceAccountKey.json');
const jsonData = fs.readFileSync(jsonPath, 'utf-8');

const base64string = Buffer.from(jsonData, 'utf-8').toString('base64');
console.log(base64string);
