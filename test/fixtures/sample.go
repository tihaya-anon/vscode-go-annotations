// Package sample 覆盖扩展要识别的每一种写法。
// +kubebuilder:object:generate=true
// +groupName=sample.example.com
package sample

import "fmt"

// Spec 是规格：doc comment, then markers in the same group.
// +kubebuilder:object:root=true
// +kubebuilder:printcolumn:name="Ready",type=string,JSONPath=`.status.conditions[?(@.type=="Ready")].status`
// +kubebuilder:rbac:groups=apps,resources=deployments,verbs=get;list;watch
type Spec struct {
	// Name 名字。
	// +optional
	// +kubebuilder:validation:MinLength=1
	Name string `json:"name,omitempty" yaml:"name"` // trailing, not a doc comment

	Plain int `json:"plain"`
	// Quoted uses an interpreted-string tag.
	Quoted string "json:\"quoted,string\""

	NoTag bool
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
	// Area 返回面积。
	Area() float64
}
