// Synthetic, public-safe manifests. Never include production endpoints or credentials.
export const yamlExampleLeft = `apiVersion: v1
kind: ConfigMap
metadata:
  name: web-config
data:
  LOG_LEVEL: info
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  resourceVersion: "101"
spec:
  replicas: 2
  template:
    spec:
      containers:
        - name: web
          image: example/web:1.0
        - name: metrics
          image: example/metrics:1.0
`;
export const yamlExampleRight = `# Same resources, different document and container order
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  resourceVersion: "102"
spec:
  replicas: 3
  template:
    spec:
      containers:
        - name: metrics
          image: example/metrics:1.0
        - name: web
          image: example/web:2.0
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: web-config
data:
  LOG_LEVEL: info
`;
export const yamlExampleOptions = { documents:'kubernetes', arrays:'key', arrayKey:'name', ignoredPaths:'', ignoreGenerated:true } as const;
