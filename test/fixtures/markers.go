// Marker placement and validity cases. Comments after a marker say what controller-gen does
// with it; test/analyze.test.ts and test/markerDiagnostics.test.ts assert the same.

// +kubebuilder:object:generate=true
// +groupName=test.example.com
package markers

// +kubebuilder:rbac:groups=detached,resources=things,verbs=get

// Reconcile is documented; markers inside a function's doc are ignored.
// +kubebuilder:rbac:groups=indoc,resources=things,verbs=get
func Reconcile() {}

// +kubebuilder:object:root=true

// Thing has markers in its doc and in the group a blank line above.
// +kubebuilder:printcolumn:name="A",type=string,JSONPath=`.spec.a`
type Thing struct {
	// A is a field.
	// +kubebuilder:validation:Minimum=1
	A int `json:"a"` // +optional

	// +kubebuilder:validation:MaxLength=3

	// B has a marker group a blank line above its doc.
	B string `json:"b"`

	// +kubebuilder:validation:MinLength=1

	// +kubebuilder:validation:MaxLength=9

	// C has two groups above its doc; only the closer one is read.
	C string `json:"c"`
}

type (
	// Grouped is a type in a parenthesised group.
	// +kubebuilder:object:root=true
	Grouped struct{}
)

func body() {
	// +kubebuilder:validation:Minimum=1
	_ = 0
}

// +kubebuilder:webhook:path=/mutate,mutating=true,failurePolicy=fail,sideEffects=None,groups=g,resources=r,verbs=create,versions=v1,name=m.example.com,admissionReviewVersions=v1

// Defaulter has a package marker a blank line above it, which controller-gen moves to the package
// (Kubebuilder scaffolds webhooks this way).
type Defaulter struct {
	// +default=false
	E *bool `json:"e"`
}

// Broken shows each kind of mistake.
// +kubebuilder:skip
// +kubebuilder:printcolumn:name="A",type=string,JSONPath=`.spec.a`,bogusArg=1
// +kubebuilder:printcolumn:name="B",JSONPath=`.spec.b`
// +kubebuilder:printcolumn:name="C",type=string,JSONPath=`.spec.c`,priority=high
// +kubebuilder:resource:Scope=Cluster
// +k8s:deepcopy-gen:interfaces=k8s.io/apimachinery/pkg/runtime.Object
// +kubebuilder:scaffold:imports
// +genclient
type Broken struct {
	// D shows field mistakes.
	// +kubebuilder:validation:Minimun=1
	// +kubebuilder:printcolumn:name="D",type=string,JSONPath=`.d`
	// +kubebuilder:validation:MaxLength
	// +kubebuilder:validation:UniqueItems=yes
	// +kubebuilder:validation:Enum=a,b
	D []string `json:"d"`
}

// +kubebuilder:rbac:groups=eof,resources=things,verbs=get
