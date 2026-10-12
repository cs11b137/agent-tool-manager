// 隔离用户级 git 配置（签名、模板等），保证测试可复现
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_AUTHOR_NAME = 'atm-test';
process.env.GIT_AUTHOR_EMAIL = 'atm@test.local';
process.env.GIT_COMMITTER_NAME = 'atm-test';
process.env.GIT_COMMITTER_EMAIL = 'atm@test.local';
process.env.GIT_TERMINAL_PROMPT = '0';
