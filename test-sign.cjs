const jwt = require('jsonwebtoken');
try {
    const token = jwt.sign({ test: 'test' }, process.env.JWT_SECRET);
    console.log(token);
} catch (e) {
    console.log(e.message);
}
