// This boundary keeps Go tooling from scanning AWS CDK's node_modules,
// which contains Go template files whose names are intentionally invalid.
module github.com/yuighjk/yy-aws-setting/infra

go 1.23.0
