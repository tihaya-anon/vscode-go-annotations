//go:build !never
// +build !never

// Package sample 覆盖扩展要识别的每一种写法。
// +kubebuilder:object:generate=true
// +groupName=sample.example.com
package sample

import "fmt"

// Spec 是规格：doc comment, then markers in the same group.
// +kubebuilder:object:root=true
// +kubebuilder:printcolumn:name="Ready",type=string,JSONPath=`.status.conditions[?(@.type=="Ready")].status`
// +kubebuilder:rbac:groups=apps,resources=deployments,verbs=get;list;watch
// +kubebuilder:resource:scope=Cluster
// +kubebuilder:subresource:status
type Spec struct {
	// Name 名字。
	// +optional
	// +kubebuilder:validation:MinLength=1
	Name string `json:"name,omitempty" yaml:"name"` // trailing, not a doc comment

	// plain is documented by its json name, as Kubernetes API conventions want.
	// +custom:tool:key=value
	Plain int `json:"plain"`
	// Quoted uses an interpreted-string tag.
	Quoted string "json:\"quoted,string\""

	NoTag bool

	// STATUS differs from both its names only in case.
	Status int `json:"status"`
}

// not a doc comment: a blank line separates it from the declaration

var detached = 1

//go:generate echo directive lines are not doc prose
// Run has a directive above its doc.
func Run() { fmt.Println(detached) }

type (
	// Grouped is documented inside a type group.
	Grouped int
)

// Shape has documented interface methods.
type Shape interface {
	// Area 返回面积，即 Area。
	Area() float64
}

type Embeds struct {
	// Grouped is embedded, so its name comes from the type.
	*Grouped
	// X and Y share a doc; NotX and X2 are other words.
	X, Y int
}

/* Block is documented by a block comment
that names Block again on its second line. */
type Block int

// lowercase starts with its own name in the wrong case.
func Lowercase() {}

// This doc does not start with the name at all.
func Unnamed() {}

// An Article may open with an article.
type Article int

// unexported declarations are not checked.
func helper() {}
